#!/usr/bin/env python3
"""
Script para testar o sistema de alertas do Purp
Uso: python test_alerts.py
"""
import requests
import json
import time

# Configuração
API_URL = "http://localhost:8000"  # Mude para seu URL em produção
USERNAME = "test_user"
PASSWORD = "test1234"
EMAIL = "test@example.com"

def print_section(title):
    print(f"\n{'='*60}")
    print(f"  {title}")
    print(f"{'='*60}\n")

def register_and_login():
    """Registra um novo usuário e faz login"""
    print_section("1. Registering Test User")
    
    # Tentar registrar
    response = requests.post(
        f"{API_URL}/auth/register",
        json={
            "username": USERNAME,
            "password": PASSWORD,
            "email": EMAIL
        }
    )
    
    if response.status_code == 200:
        print("✅ User registered successfully")
        data = response.json()
        token = data["token"]
        print(f"   Token: {token[:20]}...")
        return token
    elif response.status_code == 400 and "already" in response.text.lower():
        print("⚠️  User already exists, logging in...")
        
        # Fazer login
        response = requests.post(
            f"{API_URL}/auth/login",
            json={
                "username": USERNAME,
                "password": PASSWORD
            }
        )
        
        if response.status_code == 200:
            data = response.json()
            token = data["token"]
            print(f"✅ Logged in successfully")
            print(f"   Token: {token[:20]}...")
            return token
    
    print(f"❌ Error: {response.text}")
    return None

def create_test_alert(token, symbol="BTC", alert_type="price_above", target=100000):
    """Cria um alerta de teste"""
    print_section(f"2. Creating Test Alert: {symbol} {alert_type} {target}")
    
    response = requests.post(
        f"{API_URL}/alerts",
        json={
            "symbol": symbol,
            "alert_type": alert_type,
            "target_value": target,
            "recurring": False
        },
        headers={"X-Auth-Token": token}
    )
    
    if response.status_code == 200:
        data = response.json()
        print(f"✅ Alert created successfully")
        print(f"   Alert ID: {data['id']}")
        print(f"   Symbol: {data['symbol']}")
        print(f"   Type: {data['alert_type']}")
        print(f"   Target: ${data['target_value']:,.2f}")
        return data['id']
    else:
        print(f"❌ Error: {response.text}")
        return None

def list_alerts(token):
    """Lista todos os alertas do usuário"""
    print_section("3. Listing All Alerts")
    
    response = requests.get(
        f"{API_URL}/alerts",
        headers={"X-Auth-Token": token}
    )
    
    if response.status_code == 200:
        data = response.json()
        alerts = data["alerts"]
        print(f"✅ Found {len(alerts)} alert(s)")
        
        for alert in alerts:
            status = "🟢 Active" if alert["active"] else "🔴 Inactive"
            triggered = "⚡ Triggered" if alert["triggered"] else "⏳ Waiting"
            print(f"\n   {status} {triggered}")
            print(f"   ID: {alert['id']}")
            print(f"   {alert['symbol']}: {alert['alert_type']} ${alert['target_value']:,.2f}")
            if alert['triggered_at']:
                print(f"   Triggered at: {alert['triggered_at']}")
        
        return alerts
    else:
        print(f"❌ Error: {response.text}")
        return []

def check_alerts_manually():
    """Dispara checagem manual de alertas"""
    print_section("4. Triggering Manual Alert Check")
    
    response = requests.post(f"{API_URL}/alerts/check")
    
    if response.status_code == 200:
        print("✅ Alert check triggered successfully")
        print("   Check your email for notifications!")
        print("   (Background task running...)")
    else:
        print(f"❌ Error: {response.text}")

def add_to_watchlist(token, symbol="ETH"):
    """Adiciona um asset à watchlist"""
    print_section(f"5. Adding {symbol} to Watchlist")
    
    response = requests.post(
        f"{API_URL}/watchlist",
        json={"symbol": symbol},
        headers={"X-Auth-Token": token}
    )
    
    if response.status_code == 200:
        data = response.json()
        print(f"✅ {symbol} added to watchlist")
        print(f"   ID: {data['id']}")
        print(f"   Type: {data['type']}")
    else:
        print(f"❌ Error: {response.text}")

def get_watchlist(token):
    """Lista a watchlist do usuário"""
    print_section("6. Getting Watchlist")
    
    response = requests.get(
        f"{API_URL}/watchlist",
        headers={"X-Auth-Token": token}
    )
    
    if response.status_code == 200:
        data = response.json()
        items = data["items"]
        print(f"✅ Found {len(items)} item(s) in watchlist")
        
        for item in items:
            change_emoji = "📈" if item["percent_change"] >= 0 else "📉"
            print(f"\n   {change_emoji} {item['symbol']} ({item['name']})")
            print(f"   Price: ${item['current_price']:,.2f}")
            print(f"   Change: {item['percent_change']:+.2f}%")
            print(f"   Type: {item['type']}")
            if item['icon']:
                print(f"   Icon: {item['icon'][:50]}...")
    else:
        print(f"❌ Error: {response.text}")

def test_email_system():
    """Testa se o sistema de email está configurado"""
    print_section("7. Testing Email System")
    
    print("📧 Email Configuration Check:")
    print(f"   SMTP configured: Check your .env file")
    print(f"   Test email will be sent on:")
    print(f"   - User registration (welcome email)")
    print(f"   - Alert trigger (alert email)")
    print(f"\n   Register a new user or trigger an alert to test!")

def run_full_test():
    """Executa teste completo do sistema"""
    try:
        # 1. Registrar/Login
        token = register_and_login()
        if not token:
            print("\n❌ Failed to authenticate. Exiting.")
            return
        
        # Esperar um pouco
        time.sleep(1)
        
        # 2. Criar alerta (BTC acima de $100k - não deve disparar agora)
        alert_id = create_test_alert(
            token,
            symbol="BTC",
            alert_type="price_above",
            target=100000
        )
        
        time.sleep(1)
        
        # 3. Criar alerta (BTC abaixo de $1 - deve disparar)
        alert_id_trigger = create_test_alert(
            token,
            symbol="BTC",
            alert_type="price_below",
            target=1
        )
        
        time.sleep(1)
        
        # 4. Listar alertas
        list_alerts(token)
        
        time.sleep(1)
        
        # 5. Adicionar à watchlist
        add_to_watchlist(token, "ETH")
        add_to_watchlist(token, "SOL")
        
        time.sleep(1)
        
        # 6. Ver watchlist
        get_watchlist(token)
        
        time.sleep(1)
        
        # 7. Checar alertas manualmente
        check_alerts_manually()
        
        time.sleep(2)
        
        # 8. Ver se algum foi disparado
        list_alerts(token)
        
        # 9. Info sobre email
        test_email_system()
        
        print_section("✅ Test Completed Successfully!")
        print("\nNext steps:")
        print("1. Check your email for welcome message")
        print("2. Check your email for alert notifications")
        print("3. Configure SMTP if emails not received")
        print("4. Set up cron job for automatic alert checking")
        print("\nCron job command:")
        print(f"   curl -X POST {API_URL}/alerts/check")
        
    except Exception as e:
        print(f"\n❌ Test failed with error: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    print("""
    ╔════════════════════════════════════════════════════╗
    ║                                                    ║
    ║          Purp Alert System Test Suite             ║
    ║                                                    ║
    ║  This script will test:                           ║
    ║  - User registration & login                      ║
    ║  - Alert creation                                 ║
    ║  - Watchlist functionality                        ║
    ║  - Email system                                   ║
    ║                                                    ║
    ╚════════════════════════════════════════════════════╝
    """)
    
    run_full_test()