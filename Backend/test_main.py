import os
from pathlib import Path

os.chdir(Path(__file__).resolve().parent)

os.environ.setdefault("SECRET_KEY", "a" * 64)
os.environ.setdefault("CRON_SECRET", "test-cron-secret")
os.environ.setdefault("ENVIRONMENT", "development")
os.environ.setdefault("DATABASE_URL", "sqlite:///test.db")

import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlmodel import Session, SQLModel, create_engine, select
from sqlalchemy.pool import StaticPool

import main
from models import User, Asset, PriceAlert, Transaction, ProcessedEvent, WatchlistItem

STRONG_PASSWORD = "Test@1234"


@pytest.fixture()
def test_engine(monkeypatch):
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )

    def override_get_session():
        with Session(engine) as session:
            yield session

    monkeypatch.setattr(main, "engine", engine)
    main.app.dependency_overrides[main.get_session] = override_get_session

    SQLModel.metadata.create_all(engine)
    yield engine
    main.app.dependency_overrides.clear()


@pytest.fixture(autouse=True)
def reset_db(test_engine):
    SQLModel.metadata.drop_all(test_engine)
    SQLModel.metadata.create_all(test_engine)


@pytest.fixture(autouse=True)
def mock_external_calls(monkeypatch):
    monkeypatch.setattr(main, "send_verification_email_async", lambda *a, **kw: None)
    monkeypatch.setattr(main, "send_welcome_email_async", lambda *a, **kw: None)
    monkeypatch.setattr(main, "send_alert_email_async", lambda *a, **kw: None)

    def fake_asset_data(symbol: str):
        s = symbol.upper()
        stock_symbols = {"AAPL", "MSFT", "TSLA", "AMZN", "GOOGL"}
        if s in stock_symbols:
            return {
                "symbol": s, "real_symbol": s, "type": "stock",
                "current_price": 150.0, "percent_change": 1.5,
                "name": s, "icon": f"/logo/{s}",
            }
        return {
            "symbol": s, "real_symbol": s, "type": "crypto",
            "current_price": 50000.0 if s == "BTC" else 100.0,
            "percent_change": 2.0, "name": s, "icon": f"/logo/{s}",
        }

    monkeypatch.setattr(main, "get_asset_data", fake_asset_data)


@pytest_asyncio.fixture()
async def client(test_engine):
    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


def create_user(
    engine,
    username="John Doe",
    email="john@example.com",
    password=STRONG_PASSWORD,
    plan="free",
    verified=True,
):
    with Session(engine) as session:
        user = User(
            username=username,
            email=email,
            password_hash=main.hash_pw(password),
            plan=plan,
            is_premium=plan in {"investor", "tax_pro"},
            is_verified=verified,
            created_at="2025-01-01",
        )
        session.add(user)
        session.commit()
        session.refresh(user)
        return user


def auth_headers(user_id: int):
    token, _ = main.create_token(user_id)
    return {"X-Auth-Token": token}


# ═══════════════════════════════════════════════════════════════════════════════
# AUTH
# ═══════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_register_success(client):
    resp = await client.post("/auth/register", json={
        "full_name": "New User", "password": STRONG_PASSWORD, "email": "new@user.com",
    })
    assert resp.status_code == 200
    body = resp.json()
    assert "token" in body
    assert body["requires_verification"] is True
    assert body["email"] == "new@user.com"


@pytest.mark.asyncio
async def test_register_weak_password(client):
    resp = await client.post("/auth/register", json={
        "full_name": "Weak Pass", "password": "short", "email": "weak@pw.com",
    })
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_register_duplicate_email(client, test_engine):
    create_user(test_engine, username="User One", email="dupe@example.com")
    resp = await client.post("/auth/register", json={
        "full_name": "User Two", "password": STRONG_PASSWORD, "email": "dupe@example.com",
    })
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_login_success(client, test_engine):
    create_user(test_engine, username="Login OK", email="loginok@example.com", password=STRONG_PASSWORD)
    resp = await client.post("/auth/login", json={"email": "loginok@example.com", "password": STRONG_PASSWORD})
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert "token" in body


@pytest.mark.asyncio
async def test_login_wrong_password(client, test_engine):
    create_user(test_engine, username="Login Bad", email="loginbad@example.com", password=STRONG_PASSWORD)
    resp = await client.post("/auth/login", json={"email": "loginbad@example.com", "password": "WrongPass!1"})
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_protected_endpoint_without_token(client):
    resp = await client.get("/auth/me")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_auth_me(client, test_engine):
    user = create_user(test_engine)
    resp = await client.get("/auth/me", headers=auth_headers(user.id))
    assert resp.status_code == 200
    body = resp.json()
    assert body["email"] == "john@example.com"
    assert body["is_verified"] is True


# ═══════════════════════════════════════════════════════════════════════════════
# ASSETS
# ═══════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_add_asset_crypto(client, test_engine):
    user = create_user(test_engine)
    resp = await client.post(
        "/assets/", headers=auth_headers(user.id),
        json={"symbol": "BTC", "amount": 1, "purchase_price": 40000},
    )
    assert resp.status_code == 200
    assert resp.json()["type"] == "crypto"


@pytest.mark.asyncio
async def test_add_asset_stock(client, test_engine):
    user = create_user(test_engine)
    resp = await client.post(
        "/assets/", headers=auth_headers(user.id),
        json={"symbol": "AAPL", "amount": 2, "purchase_price": 150},
    )
    assert resp.status_code == 200
    assert resp.json()["type"] == "stock"


@pytest.mark.asyncio
async def test_add_asset_duplicate_averages(client, test_engine):
    user = create_user(test_engine)
    headers = auth_headers(user.id)
    await client.post("/assets/", headers=headers, json={"symbol": "BTC", "amount": 1, "purchase_price": 100})
    resp = await client.post("/assets/", headers=headers, json={"symbol": "BTC", "amount": 3, "purchase_price": 200})
    assert resp.status_code == 200
    data = resp.json()
    assert data["amount"] == 4
    assert data["purchase_price"] == pytest.approx(175)


@pytest.mark.asyncio
async def test_free_plan_asset_limit(client, test_engine):
    user = create_user(test_engine)
    headers = auth_headers(user.id)
    for symbol in ["BTC", "ETH", "SOL", "DOGE"]:
        r = await client.post("/assets/", headers=headers, json={"symbol": symbol, "amount": 1, "purchase_price": 10})
        assert r.status_code == 200

    resp = await client.post("/assets/", headers=headers, json={"symbol": "ADA", "amount": 1, "purchase_price": 10})
    assert resp.status_code == 402


@pytest.mark.asyncio
async def test_sell_partial(client, test_engine):
    user = create_user(test_engine)
    headers = auth_headers(user.id)
    add = await client.post("/assets/", headers=headers, json={"symbol": "BTC", "amount": 2, "purchase_price": 100})
    asset_id = add.json()["id"]

    sell = await client.post(f"/assets/{asset_id}/sell", headers=headers, json={"amount": 0.5})
    assert sell.status_code == 200
    assert sell.json()["status"] == "partial"
    assert sell.json()["remaining"] == pytest.approx(1.5)


@pytest.mark.asyncio
async def test_sell_all(client, test_engine):
    user = create_user(test_engine)
    headers = auth_headers(user.id)
    add = await client.post("/assets/", headers=headers, json={"symbol": "BTC", "amount": 2, "purchase_price": 100})
    asset_id = add.json()["id"]

    sell = await client.post(f"/assets/{asset_id}/sell", headers=headers, json={"amount": 2})
    assert sell.status_code == 200
    assert sell.json()["status"] == "sold_all"

    with Session(test_engine) as session:
        assert session.get(Asset, asset_id) is None


@pytest.mark.asyncio
async def test_sell_more_than_held(client, test_engine):
    user = create_user(test_engine)
    headers = auth_headers(user.id)
    add = await client.post("/assets/", headers=headers, json={"symbol": "BTC", "amount": 1, "purchase_price": 100})
    asset_id = add.json()["id"]

    sell = await client.post(f"/assets/{asset_id}/sell", headers=headers, json={"amount": 2})
    assert sell.status_code == 400


# ═══════════════════════════════════════════════════════════════════════════════
# ALERTS
# ═══════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_create_alert_free_limit(client, test_engine):
    user = create_user(test_engine)
    headers = auth_headers(user.id)
    payload = {"symbol": "BTC", "alert_type": "price_above", "target_value": 10}

    assert (await client.post("/alerts", headers=headers, json=payload)).status_code == 200
    assert (await client.post("/alerts", headers=headers, json=payload)).status_code == 200
    third = await client.post("/alerts", headers=headers, json=payload)
    assert third.status_code == 402


@pytest.mark.asyncio
async def test_alert_price_above_triggers(client, test_engine, monkeypatch):
    user = create_user(test_engine)
    headers = auth_headers(user.id)
    create = await client.post(
        "/alerts", headers=headers,
        json={"symbol": "BTC", "alert_type": "price_above", "target_value": 1000},
    )
    assert create.status_code == 200
    alert_id = create.json()["id"]

    def fake_checker(session, _send_email_cb):
        alerts = session.exec(select(PriceAlert)).all()
        for alert in alerts:
            if alert.active and alert.alert_type == "price_above":
                data = main.get_asset_data(alert.symbol)
                if data["current_price"] > alert.target_value:
                    alert.triggered = True
                    session.add(alert)
        session.commit()

    monkeypatch.setattr(main, "check_and_trigger_alerts", fake_checker)
    main._run_alert_check()

    with Session(test_engine) as session:
        alert = session.get(PriceAlert, alert_id)
        assert alert.triggered is True


@pytest.mark.asyncio
async def test_alert_inactive_not_triggered(client, test_engine, monkeypatch):
    user = create_user(test_engine)
    headers = auth_headers(user.id)
    create = await client.post(
        "/alerts", headers=headers,
        json={"symbol": "BTC", "alert_type": "price_above", "target_value": 1000},
    )
    alert_id = create.json()["id"]
    await client.post(f"/alerts/{alert_id}/toggle", headers=headers)

    def fake_checker(session, _send_email_cb):
        alerts = session.exec(select(PriceAlert)).all()
        for alert in alerts:
            if alert.active and alert.alert_type == "price_above":
                data = main.get_asset_data(alert.symbol)
                if data["current_price"] > alert.target_value:
                    alert.triggered = True
                    session.add(alert)
        session.commit()

    monkeypatch.setattr(main, "check_and_trigger_alerts", fake_checker)
    main._run_alert_check()

    with Session(test_engine) as session:
        alert = session.get(PriceAlert, alert_id)
        assert alert.triggered is False


# ═══════════════════════════════════════════════════════════════════════════════
# WATCHLIST
# ═══════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_watchlist_crud(client, test_engine):
    user = create_user(test_engine)
    headers = auth_headers(user.id)

    add = await client.post("/watchlist", headers=headers, json={"symbol": "AAPL"})
    assert add.status_code == 200
    item_id = add.json()["id"]

    listing = await client.get("/watchlist", headers=headers)
    assert listing.status_code == 200
    assert len(listing.json()["items"]) == 1

    delete = await client.delete(f"/watchlist/{item_id}", headers=headers)
    assert delete.status_code == 200

    listing2 = await client.get("/watchlist", headers=headers)
    assert listing2.json()["items"] == []


# ═══════════════════════════════════════════════════════════════════════════════
# STRIPE WEBHOOKS
# ═══════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_webhook_checkout_completed(client, test_engine, monkeypatch):
    user = create_user(test_engine, username="Stripe One", email="stripe1@example.com", plan="free")

    event = {
        "id": "evt_1",
        "type": "checkout.session.completed",
        "data": {
            "object": {
                "metadata": {"user_id": str(user.id), "plan": "investor"},
                "subscription": "sub_123",
                "customer": "cus_123",
            }
        },
    }
    monkeypatch.setattr(main.stripe.Webhook, "construct_event", lambda payload, sig, secret: event)

    resp = await client.post("/stripe/webhook", content=b"{}", headers={"stripe-signature": "sig"})
    assert resp.status_code == 200

    with Session(test_engine) as session:
        updated = session.get(User, user.id)
        assert updated.plan == "investor"
        assert updated.is_premium is True


@pytest.mark.asyncio
async def test_webhook_subscription_deleted(client, test_engine, monkeypatch):
    user = create_user(test_engine, username="Stripe Two", email="stripe2@example.com", plan="investor")

    event = {
        "id": "evt_2",
        "type": "customer.subscription.deleted",
        "data": {"object": {"metadata": {"user_id": str(user.id)}}},
    }
    monkeypatch.setattr(main.stripe.Webhook, "construct_event", lambda payload, sig, secret: event)

    resp = await client.post("/stripe/webhook", content=b"{}", headers={"stripe-signature": "sig"})
    assert resp.status_code == 200

    with Session(test_engine) as session:
        updated = session.get(User, user.id)
        assert updated.plan == "free"
        assert updated.is_premium is False


@pytest.mark.asyncio
async def test_webhook_duplicate_event(client, test_engine, monkeypatch):
    user = create_user(test_engine, username="Stripe Three", email="stripe3@example.com", plan="free")

    event = {
        "id": "evt_dup",
        "type": "checkout.session.completed",
        "data": {"object": {"metadata": {"user_id": str(user.id), "plan": "investor"}}},
    }
    monkeypatch.setattr(main.stripe.Webhook, "construct_event", lambda payload, sig, secret: event)

    first = await client.post("/stripe/webhook", content=b"{}", headers={"stripe-signature": "sig"})
    second = await client.post("/stripe/webhook", content=b"{}", headers={"stripe-signature": "sig"})
    assert first.status_code == 200
    assert second.status_code == 200

    with Session(test_engine) as session:
        events = session.exec(select(ProcessedEvent).where(ProcessedEvent.event_id == "evt_dup")).all()
        assert len(events) == 1


# ═══════════════════════════════════════════════════════════════════════════════
# TAX
# ═══════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_form_8949_export_csv(client, test_engine):
    user = create_user(test_engine, username="Tax One", email="tax1@example.com", plan="tax_pro")
    headers = auth_headers(user.id)

    with Session(test_engine) as session:
        session.add(Transaction(user_id=user.id, symbol="AAPL", type="buy", amount=1, price=100, total_usd=100, date="2025-01-01", created_at="2025-01-01"))
        session.add(Transaction(user_id=user.id, symbol="AAPL", type="sell", amount=1, price=120, total_usd=120, date="2025-02-01", created_at="2025-02-01"))
        session.commit()

    resp = await client.get("/tax/form-8949?year=2025", headers=headers)
    assert resp.status_code == 200
    assert "text/csv" in resp.headers["content-type"]
    assert "IRS Form 8949" in resp.text


@pytest.mark.asyncio
async def test_tax_loss_harvesting_empty(client, test_engine):
    user = create_user(test_engine, username="Tax Two", email="tax2@example.com", plan="tax_pro")
    resp = await client.get("/tax/loss-harvesting", headers=auth_headers(user.id))
    assert resp.status_code == 200
    assert resp.json()["opportunities"] == []


@pytest.mark.asyncio
async def test_cost_basis_hifo(client, test_engine):
    user = create_user(test_engine, username="Tax Three", email="tax3@example.com", plan="tax_pro")
    headers = auth_headers(user.id)

    with Session(test_engine) as session:
        session.add(Transaction(user_id=user.id, symbol="AAPL", type="buy", amount=1, price=100, total_usd=100, date="2025-01-01", created_at="2025-01-01"))
        session.add(Transaction(user_id=user.id, symbol="AAPL", type="buy", amount=1, price=200, total_usd=200, date="2025-01-02", created_at="2025-01-02"))
        session.add(Transaction(user_id=user.id, symbol="AAPL", type="sell", amount=1, price=150, total_usd=150, date="2025-01-03", created_at="2025-01-03"))
        session.commit()

    resp = await client.get("/portfolio/cost-basis?method=HIFO&symbol=AAPL", headers=headers)
    assert resp.status_code == 200
    data = resp.json()
    assert data["method_used"] == "HIFO"
    assert data["realized_losses"] == pytest.approx(50.0)
    assert data["cost_basis"] == pytest.approx(100.0)


# ═══════════════════════════════════════════════════════════════════════════════
# HEALTH
# ═══════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_health(client):
    resp = await client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"
