# Host the Oura receiver in Supabase

This repository owns the Oura webhook receiver as a Supabase Edge Function in the personal health data project, so the receiver and database share one deployment platform. The function verifies Oura notifications before accepting them and keeps credentials server-side. Apply changes to the shared production project manually.

An owner-only command starts or restores the Oura Connection through the browser and reports sync status. The backend refreshes access automatically and reports when the owner needs to reconnect.
