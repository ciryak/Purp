"""add user profile locale currency full_name

Revision ID: a1b2c3d4e5f6
Revises: 53829c2c44c4
Create Date: 2026-02-28

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a1b2c3d4e5f6"
down_revision: Union[str, Sequence[str], None] = "53829c2c44c4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("user", sa.Column("full_name", sa.String(), nullable=True))
    op.add_column("user", sa.Column("locale", sa.String(), nullable=True))
    op.add_column("user", sa.Column("currency", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("user", "currency")
    op.drop_column("user", "locale")
    op.drop_column("user", "full_name")
