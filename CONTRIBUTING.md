# Contributing to deskhand

Thanks for helping. deskhand is Apache-2.0 licensed.

## Developer Certificate of Origin

We use the [Developer Certificate of Origin](https://developercertificate.org/) instead of a CLA. Every commit
must carry a `Signed-off-by` line with your real name and email, which `git commit -s` adds for you:

    Signed-off-by: Your Name <you@example.com>

## Development

No Node install is needed on your machine; everything runs in containers.

    scripts/dev pnpm install
    scripts/dev pnpm -r build
    scripts/dev pnpm -r test

See `CLAUDE.md` for conventions and `docs/design.md` for how the parts fit together.

## Bundled software

Every app and font added to an image must allow redistribution; list it in `NOTICE`.
