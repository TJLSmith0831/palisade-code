# Use Clerk for Palisade account authentication

Palisade will use Clerk for required Google, GitHub, and one-time email-code sign-in. Supabase was considered and rejected because free-project pausing and a $25/month production commitment before user traction do not fit the launch plan; use Clerk's free tier for launch, subject to verifying the desktop integration and required capabilities. Future feature flags are planned on Railway and are outside this authentication change.

All three sign-in methods will open the system browser and return to Palisade afterward. Mantine supplies the desktop sign-in prompt and progress/error states; Clerk supplies the browser authentication experience. This keeps authentication out of the embedded webview and follows common native-app sign-in behavior.
