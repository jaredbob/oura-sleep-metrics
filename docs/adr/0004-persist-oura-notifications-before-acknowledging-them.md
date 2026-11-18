# Persist Oura notifications before acknowledging them

Save verified notifications durably before the receiver returns success, so a failed fetch or database write can be retried independently of Oura's delivery retry window. Renew subscriptions automatically before their reported expiration and provide an owner-only date-range repair command for changes missed during an outage. Apply corrections and deletions idempotently by Oura document ID.
