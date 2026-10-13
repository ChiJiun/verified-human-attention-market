# Campaign Moderation, Reports and Disputes

> Status: accepted for the early beta (#24). Threat Model T-010 / T-014.
> Code: `apps/api/src/moderation/`.

## Selected gate for the beta

**Every campaign is reviewed by an operator before it is served**, except
campaigns from advertisers on `ADVERTISER_ALLOWLIST` (known partners), which
start approved. `MODERATION_MODE=review` is the default and the only mode the
API accepts outside the local anvil chain; `open` exists for local demos.

The gate is enforced by the API, not the web app. Until a campaign is
`approved`:

- `POST /v1/campaigns/:id/publish` returns `403 CAMPAIGN_NOT_APPROVED`, so the
  web app never offers the on-chain create step;
- the mission, World ID eligibility and submissions endpoints return `403`.

An advertiser can still call `createCampaign` on the contract directly (the
contract is permissionless). That campaign cannot reach participants: the
indexer links it, but the API refuses to serve its mission. The advertiser can
refund their own unused budget after the refund delay.

## URL policy

Checked at campaign creation (`checkContentUrl`):

- `https:` only — no `http:`, `javascript:`, `data:` or other schemes;
- no embedded credentials (`https://user@host`, the classic look-alike trick);
- no IP-literal hosts (including shorthand forms like `0x7f.1`);
- no single-label or internal hosts (`localhost`, `*.local`, `*.internal`, …);
- default port only; at most 2048 characters;
- optional `CONTENT_DOMAIN_ALLOWLIST` (exact domain or subdomain).

These are syntactic. Whether the page is safe (phishing, malware, redirects,
wallet drainers) is the reviewer's call: open the URL in an isolated browser
profile with no wallet extension, follow redirects, and check the domain age
and reputation before approving.

## States and transitions

```text
pending_review ──approve──▶ approved ──take_down──▶ taken_down
      │  ▲                     ▲                         │
   reject│ approve              └────────reinstate────────┘
      ▼  │
   rejected            pending_review ──take_down──▶ taken_down
```

Any other transition returns `409 INVALID_TRANSITION`. Every action requires a
reason and is appended to `moderation_actions` with the operator wallet,
previous and new status, optional report id and timestamp. A database trigger
rejects `UPDATE` and `DELETE` on that table.

## Take-down

`take_down` stops new participants immediately (`410 CAMPAIGN_TAKEN_DOWN` on
mission, eligibility and submissions). It does **not**:

- revoke claim authorizations or block claims for submissions that were
  already accepted — that work was done in good faith and is paid from the
  advertiser's escrow;
- move funds. Unused budget returns to the advertiser through the normal
  close/refund flow.

If the campaign itself is an attack on participants (for example the content
asks for seed phrases), additionally: pause the contract (`pause()`, owner
only — this stops all claims, see the operations runbook), and post a notice.

## Reports and disputes

- Anyone can report a campaign: `POST /v1/campaigns/:id/reports` with a fixed
  reason and optional 500-character details. The reporter is not identified
  or stored (privacy policy, #22).
- Operators triage `GET /v1/admin/reports?status=open`, act on the campaign
  (passing `reportId` links the action to the report) and resolve the report
  as `dismissed` or `actioned` with a reason. Resolution is also audited.
- Advertiser disputes (e.g. against a take-down) go to the operators out of
  band in the beta; the answer is recorded as a `reinstate` or as a resolved
  report, so the trail shows who decided what and why.

## Settlement history is out of reach

Moderation data lives in its own tables (`campaign_moderation`,
`campaign_reports`, `moderation_actions`). No admin endpoint writes
campaigns, submissions, claims or chain events. In addition:

- a trigger forbids deleting submissions or changing their result,
  rejection code, campaign, eligibility, mission or creation time (only
  claim fields for reissue and the wallet pseudonymization of the retention
  policy may change);
- settlement amounts come from on-chain events and are re-derivable from the
  chain, so even a database operator cannot change what was funded, paid or
  refunded without the chain disagreeing (reconciliation flags it).

## Permissions

| Role | How | Can |
| --- | --- | --- |
| Participant / public | — | Report a campaign |
| Advertiser | SIWE, own campaigns | Create drafts, publish once approved, see own analytics. Cannot approve own campaign. |
| Operator | SIWE wallet in `OPERATOR_ADDRESSES` | Review queue, approve/reject/take down/reinstate with a reason, resolve reports, read audit trail |
| Contract owner | Owner key (see #23) | Pause/unpause, rotate claim signer. Not an API role. |
| Database admin | Infrastructure | Schema migrations (reviewed in git). Triggers make silent edits to audits and results fail. |

Operators are listed in configuration, so adding or removing one is a
reviewed deployment change. Keep operator wallets separate from the contract
owner and the claim signer.
