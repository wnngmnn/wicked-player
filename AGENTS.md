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

- Album sharing packs bounded, uncompressed ZIP volumes in the browser and streams them through authenticated server routes to the owner's Pixeldrain connector; recipients download through the app, so no one else needs a file-host key.
- Imported album files are written only to the selected main folder and rolled back on failure; library metadata is added only after all parts pass validation.
- Share links carry only an unguessable share ID; parts are served only for shares marked complete, never via public CORS proxies.
