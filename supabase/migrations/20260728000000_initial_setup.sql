-- Private objects used by backend-only integration logic belong here.
-- Business tables will be added after the agent workflows are finalized.
create schema if not exists app_private;

revoke all on schema app_private from public;
revoke all on schema app_private from anon;
revoke all on schema app_private from authenticated;

grant usage on schema app_private to service_role;

comment on schema app_private is
  'Backend-only objects for SuryaDev AI agent integrations.';
