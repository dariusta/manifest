---
'manifest': patch
---

Refresh the Google subscription model catalog to the models Antigravity Cloud Code actually serves. "Sign in with Google" connections now offer Gemini 3.1 Pro (high/low), Gemini 3.8 Flash (high/medium/low), and Gemini 3.7 Flash instead of the stale Gemini 2.5 and 3.1 Flash Lite list.

The old entries were public Gemini API ids left over from the Gemini Code Assist backend. Since the migration to Antigravity, the subscription route forwards the model id verbatim in the Code Assist envelope, so those ids no longer resolved — any route pinned to `gemini-2.5-*` on a Google **subscription** was already failing and will now disappear from discovery. Google API-key connections are unaffected.
