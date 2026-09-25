# Contributing

Contributions are welcome under `GPL-2.0-or-later`; contributors retain copyright
in their work. Forum Fortress does not require a contributor licence agreement
or copyright assignment. Please preserve the Forum Fortress copyright and SPDX
headers, do not include credentials or customer data, and add or update tests
for protocol, hook, and privacy behavior.

Before submitting a change, run:

```bash
npm test
npm run check
```

The NodeBB source used to verify hook contracts should be current NodeBB 4.x.
Blocking checks must return the original filter payload object on every
pass-through path.
