# Keep Oura API records in dedicated tables

Use dedicated Oura tables linked to the same Supabase user as the existing HealthKit data so queries can join the two sources while preserving how each measurement was collected. Store the selected values, Oura document IDs, and relevant dates and timestamps, using Oura's reported day and the Main Sleep Session for HRV. Import all available history for those metrics on first connection and use Oura Webhook Notifications for ongoing updates.

An owner-only SQL view presents nightly data for joins by owner and date, with five-minute HRV samples available by Sleep Session. Update the existing record when Oura corrects it, and remove the record and its dependent HRV samples when Oura reports its deletion.
