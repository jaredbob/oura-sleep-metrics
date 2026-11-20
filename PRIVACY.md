# Privacy Policy

Last updated November 19, 2026

Personal Sleep Metrics is a planned integration for one account owner to track
their sleep and recovery. This policy describes how the integration will
handle data once the owner enables it and authorizes access in Oura.

## Data collected and why

With the owner's permission, the integration will import available history and
receive updates for Sleep Score, Readiness Score, nighttime temperature
deviation, average overnight blood oxygen (SpO₂), and average and five-minute
heart rate variability from the main sleep session. The integration also
imports Enhanced Tag codes, custom names, dates, and times, Cardiovascular Age
and pulse wave velocity, VO₂ Max, Daily Stress durations and summaries, and
Daily Resilience levels and contributors. Optional tag comments are discarded.
The owner can query these records alongside their other personal health metrics.

To connect the accounts and keep records current, the integration will process
account and record identifiers, dates and timestamps, OAuth credentials, and
webhook and sync metadata. This information supports authorization, imports,
corrections, deletions, and troubleshooting.

## Storage and disclosures

Supabase will host the integration and its private database. Oura will receive
the authorization and API requests needed to operate the connection. The
owner's account will control access to the stored readings. The backend will
keep authorization credentials server-side. Data use is limited to personal
tracking and the processing necessary to provide it.

## Retention and deletion

The integration will retain authorized readings while the owner needs them for
personal tracking. It will retain credentials while access is authorized and
keep delivery and diagnostic records only as long as needed for sync, retries,
or troubleshooting.

The owner can access stored readings through their private queries and can
revoke sharing at any time through **Settings → App Integrations** in the
Oura app. The integration will stop processing Oura data when consent is
withdrawn. [Oura's guide to managing data access](https://support.ouraring.com/hc/en-us/articles/360025586673-How-Oura-Protects-Your-Data)

The owner can request access to or deletion of integration data using the
private contact email listed in the Oura app registration. The operator will
honor deletion requests promptly and within 72 hours. Deleting all integration
data also ends sync and covers stored Oura readings, data derived from them,
account credentials, and pending sync work. Before enabling live sync, the
operator will verify that the deletion procedure covers retained copies,
including any backups or logs that contain recoverable Oura data.
