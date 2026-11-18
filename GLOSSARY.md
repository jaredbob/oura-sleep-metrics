# Oura Sleep Metrics

This project collects Oura health data outside the scope of Oura’s built-in Apple Health export.

## Language

**Oura Connection**:
The owner’s authorization for this integration to read selected data from their Oura account.

**Oura Document**:
A record that Oura makes available through its API, such as a sleep session or a daily sleep summary.

**Oura Webhook Notification**:
A message from Oura identifying an Oura Document and reporting that it was created, updated, or deleted.

**Sleep Session**:
An individual period of sleep recorded by Oura. Oura can record multiple Sleep Sessions for the same Sleep Day.

**Sleep Day**:
The local 6 p.m. to 6 p.m. interval Oura uses to group sleep for the Sleep Score.

**Main Sleep Session**:
The Sleep Session that Oura identifies as the primary sleep for a Sleep Day.

**Overnight SpO₂**:
The average blood oxygen saturation Oura estimates during the Main Sleep Session, expressed as a percentage.
