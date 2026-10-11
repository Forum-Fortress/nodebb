# NodeBB npm release procedure

Public NodeBB packages are built and published only from annotated release tags
created by the reviewed private Forum Fortress publisher. A new tag vX.Y.Z
must match package.json, be reachable from public main, and pass independent
lint, unit tests, npm pack checks and registry content verification.

GitHub-hosted [Publish npm release](.github/workflows/publish-npm.yml) uses
npm's OIDC trusted-publisher identity. No npm token or private service
credentials enter GitHub Actions. npm versions are immutable; a retry compares
existing npm package contents with the reviewed tag and fails on differences.

## One-time npm configuration

Once this workflow is merged, configure a trusted publisher on the npm page
for `nodebb-plugin-forum-fortress`: provider **GitHub Actions**, organisation
`Forum-Fortress`, repository `nodebb`, workflow file `publish-npm.yml`,
environment blank, and **allow npm publish** (not only staged publish).

Configure close to the next tagged release: newly configured publishers
expire after two days without validation. Node 24 supplies npm 11.5.1+
needed for OIDC; customers can still run the plugin on Node 22.

Keep the existing protected Control npm credential until the first OIDC
publication has succeeded and the monorepo full-release path has been
adjusted so it does not publish NodeBB independently. Protect public
main and v* tags. Never create a tag from an unreviewed PR or move one.
