"""Provider plugins — one module per provider (21 total).

Each module implements the plugin duck-type from the JS registry:
id/label/auth + configure/config/set_auth/interval_seconds/fetch/parse/meta.
See PLAN-python-rewrite.md §4 for the locked data models.
"""