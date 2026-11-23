<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Album sharing runs in browser-only event handlers using bounded, uncompressed ZIP volumes; this keeps audio transfers off the app server and avoids recompressing existing MP3s.
- Imported album files are written only to the selected main folder and rolled back on failure; library metadata is added only after all parts pass validation.
- Third-party share links accept only Pixeldrain file IDs; direct download restrictions fall back to selecting downloaded ZIP files rather than public CORS proxies.
