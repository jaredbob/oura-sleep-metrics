-- Oura sync uses a direct Postgres connection. Keep these collections out of the Data API.
revoke all privileges on table
  public.oura_enhanced_tag,
  public.oura_daily_cardiovascular_age,
  public.oura_vo2_max,
  public.oura_daily_stress,
  public.oura_daily_resilience
from public, anon, authenticated, service_role;
