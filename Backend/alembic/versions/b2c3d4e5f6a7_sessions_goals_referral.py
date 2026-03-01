"""add UserSession InvestmentGoal RevokedJti referral

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-02-28

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b2c3d4e5f6a7"
down_revision: Union[str, Sequence[str], None] = "a1b2c3d4e5f6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("user", sa.Column("referral_code", sa.String(), nullable=True))
    op.add_column("user", sa.Column("referred_by_id", sa.Integer(), nullable=True))
    op.create_index(op.f("ix_user_referral_code"), "user", ["referral_code"], unique=True)

    op.create_table(
        "revokedjti",
        sa.Column("jti", sa.String(length=64), nullable=False),
        sa.PrimaryKeyConstraint("jti"),
    )
    op.create_table(
        "usersession",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("jti", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.String(), nullable=False),
        sa.Column("user_agent", sa.String(), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_usersession_jti"), "usersession", ["jti"], unique=True)
    op.create_index(op.f("ix_usersession_user_id"), "usersession", ["user_id"], unique=False)

    op.create_table(
        "investmentgoal",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("label", sa.String(), nullable=False),
        sa.Column("target_value", sa.Float(), nullable=False),
        sa.Column("target_date", sa.String(), nullable=True),
        sa.Column("created_at", sa.String(), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_investmentgoal_user_id"), "investmentgoal", ["user_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_investmentgoal_user_id"), table_name="investmentgoal")
    op.drop_table("investmentgoal")
    op.drop_index(op.f("ix_usersession_user_id"), table_name="usersession")
    op.drop_index(op.f("ix_usersession_jti"), table_name="usersession")
    op.drop_table("usersession")
    op.drop_table("revokedjti")
    op.drop_index(op.f("ix_user_referral_code"), table_name="user")
    op.drop_column("user", "referred_by_id")
    op.drop_column("user", "referral_code")
