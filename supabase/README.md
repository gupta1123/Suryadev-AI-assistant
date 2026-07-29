# Supabase database

This folder is the source of truth for database migrations and local seed data.

- `config.toml` configures the optional local Supabase stack.
- `migrations/` contains ordered SQL migrations for local and hosted projects.
- `seed.sql` contains optional deterministic development-only data.

Application tables should use lowercase `snake_case` identifiers, appropriate
Postgres types, indexed foreign keys, and Row Level Security whenever they are
exposed through Supabase's public API.

The frontend must use only a publishable/anonymous key. The service-role key
must remain in the backend environment and must never be committed.

The invoice-delivery worker claims queue rows through a service-role-only RPC
using `FOR UPDATE SKIP LOCKED`. The external MSG91 call is made after that short
claim transaction completes so a slow provider cannot hold database locks.
