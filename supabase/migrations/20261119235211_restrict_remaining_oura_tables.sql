-- Keep the original Oura tables and the nightly view out of the Data API.
revoke all privileges on table
  public.oura_daily_sleep,
  public.oura_daily_spo2,
  public.oura_daily_readiness,
  public.oura_hrv_samples,
  public.oura_nightly
from public, anon, authenticated, service_role;

-- Remove grants the authenticated nightly view used to rely on.
revoke all privileges on all tables in schema oura_private
from public, anon, authenticated, service_role;
