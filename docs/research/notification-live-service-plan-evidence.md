# Knock planning evidence: does Cadence need a live account now?

Accessed **2026-11-16**. Public primary documentation only; no account, credentials, service calls, or application changes. This supplements [the earlier comparison](cadence-notification-services.md), which is not a final vendor recommendation.

**Assessment:** no remaining planning question examined here demonstrably requires signup. Public sources establish a plausible Free-plan fit for the agreed custom feed and preferences. Commercial uncertainties need clarification or a product decision; a working API call cannot settle them. Actual integration still needs a live account when implementation reaches service verification. This assessment does not select Knock, authorize payment, or waive that verification.

The product inputs are [Which notification vendor should we prototype first?](https://github.com/bzhang-coke/cohort-005-project/issues/12) and [Which Notifications may people mute in the Notification Feed?](https://github.com/bzhang-coke/cohort-005-project/issues/16): in-app only; optional Discussion activity and Seat claims; mandatory Refund Request activity; defaults on; one preference scope per person; preserved history and no replay. The approved sample-data UI is an input, not evidence of hosted behavior.

## Current entitlement and limits

| Subject | Public evidence and planning implication |
| --- | --- |
| Free allowance | $0, no card required, up to 10,000 delivered messages monthly. Unlimited stored profiles, account members, workflows, channels, and environments. Members mean dashboard users, not Cadence recipients. [Pricing](https://knock.app/pricing) |
| Required APIs/UI | Free includes user/category preferences, Feed API, custom components, and API/CLI management. [Pricing](https://knock.app/pricing) |
| Headless behavior | Knock documents fully custom React UI using its feed API and realtime service. Read and seen are separate; headless code owns seen-state updates. [Headless feed](https://docs.knock.app/in-app-ui/react/headless/feed) |
| Metering | One successfully delivered recipient/channel message counts; preference-skipped steps do not. Development delivery counts too. In-app feeds cannot use channel sandbox mode, so test delivery consumes allowance. [Usage documentation](https://docs.knock.app/manage-your-account/knock-plans) |
| Cutoff | Free messages are **not hard-capped**. The FAQ says Knock contacts over-limit customers about a payment method for the next month. [Pricing FAQ](https://knock.app/pricing#frequently-asked-questions) |
| Financial qualification | The current Terms, dated March 4, 2026, say exceeding Free entails fees for that billing period under the pricing page. A missing card does not establish zero liability. The precise Free-overage calculation/grace treatment is not stated clearly enough to assume. [Terms, Fees](https://knock.app/legal/terms-of-service) |
| Paid path/branding | Starter is $250/month, includes 50,000 messages, then $0.005/message. Branding removal is unavailable on Free and included in Starter. No upgrade is authorized. [Pricing](https://knock.app/pricing) |
| Retention | Non-Enterprise message/workflow logs expire after 30 days. In-app feed items remain available indefinitely through the feed endpoint, with status updates still supported. Feed history and debugging logs therefore have different retention. [Data retention](https://docs.knock.app/manage-your-account/data-retention) |
| Material feature gates | Per-tenant preferences/branding, custom permission groups, SAML/SCIM, and advanced exports are Enterprise features. Cadence's agreed personal preferences do not require per-tenant preferences. [Plan documentation](https://docs.knock.app/manage-your-account/knock-plans) |
| API limits | Endpoint rate limits apply regardless of pricing plan; excess requests return 429. These are separate from the monthly allowance. [API reference](https://docs.knock.app/api-reference/overview/rate-limits) |

**Attribution uncertainty:** neither the reviewed pricing table, headless guide, nor public Terms explains the exact attribution text, placement, or exemption for a wholly custom feed. Custom-component availability is not proof of a branding exemption. If this affects selection, obtain written vendor clarification or accept a specifically established branding condition before commitment. Signup and inspection of a working UI would not establish contractual permission. [Pricing](https://knock.app/pricing), [headless guide](https://docs.knock.app/in-app-ui/react/headless/feed), [Terms](https://knock.app/legal/terms-of-service)

## Preference model and mandatory delivery

Knock stores a recipient's `default` preference set, with category, workflow, channel, and channel-type settings. Unspecified preferences are enabled. A single recipient identity and `default` set can therefore represent Cadence's personal, global choices; the two optional categories can be scoped to `in_app_feed`. This mapping is a design inference, not a tested configuration. [Preference schema](https://docs.knock.app/api-reference/recipients/preferences)

Category preferences apply across workflows assigned that category. A false category suppresses delivery even when a channel is enabled. Environment defaults are a baseline; recipient settings override them. Defaulting Refund Request preferences to true alone would not enforce mandatory delivery. [Preference evaluation](https://docs.knock.app/preferences/overview)

Knock provides a workflow-level override that ignores recipient preferences. It must be committed to take effect. A candidate design could use it for mandatory Refund Request workflows while optional workflows respect preferences. Recipient eligibility and deduplication remain Cadence responsibilities. [Workflow overrides](https://docs.knock.app/preferences/overview#advanced-concepts), [workflow settings schema](https://docs.knock.app/mapi-reference/workflows)

Preference updates replace the complete set by default; `__persistence_strategy__: "merge"` performs a partial merge. A toggle update must preserve the other choice. [Update preference API](https://docs.knock.app/api-reference/users/set_preferences)

### Preventing unauthorized preference changes

Enhanced security is off by default. Enable it explicitly; issue backend-signed, expiring user JWTs from the authenticated Cadence identity. Public-key requests otherwise can act as arbitrary users. `explicit_grants: true` restricts a token to enumerated grants; documented grants distinguish feed access and preference writes, but do not expose a category-level write permission. [Authentication and grants](https://docs.knock.app/in-app-ui/security-and-authentication)

**Viable design inference:** give the browser only required feed access (and preference reads if needed), omit both `preferences/write` and `user/write`, and route preference mutations through Cadence. The server derives the person from the session and accepts only the two optional-category booleans. It rejects mandatory-category, global-channel, workflow, and arbitrary preference payloads before calling Knock with server credentials. This prevents forged mutations from bypassing the UI. Workflow overrides separately preserve mandatory delivery. The exact grant configuration and rejection cases need integration tests; hiding a toggle is insufficient. [Grant model](https://docs.knock.app/in-app-ui/security-and-authentication)

### Forward changes, history, and delayed work

Knock evaluates preferences when deciding whether a workflow sends; its API model supports suppression rather than merely hiding feed rows. Cadence should therefore leave existing feed entries/statuses untouched and never retrigger suppressed activity on unmute. This is an integration inference from [preference evaluation](https://docs.knock.app/preferences/overview) and the separate [feed/status APIs](https://docs.knock.app/in-app-ui/api-overview), not an observed no-replay guarantee.

Recipient preferences are re-read on each workflow step, including after delays. Thus the vendor does not inherently freeze preferences at Cadence event time. [Delay documentation](https://docs.knock.app/designing-workflows/delay-function)

[How should Cadence produce, store, and deliver its Notifications?](https://github.com/bzhang-coke/cohort-005-project/issues/17) must define the preference-evaluation boundary for delayed/retried dispatch and preserve permanent suppression. Once an event is suppressed under that agreed rule, a retry must not make it deliverable after unmuting. Event-time versus dispatch-time evaluation remains undecided. Deciding that rule and the storage/synchronization design does not require an account.

## What remains, and what actually needs live access

| Remaining item | Correct place to resolve it |
| --- | --- |
| Exact custom-feed attribution requirement | Written vendor clarification; then human acceptance under the vendor decision. No account demonstrated necessary. |
| Free-only operation despite no hard cutoff | Vendor decision accepts operating constraints; integration planning chooses budget/control behavior. Exact overage/grace assurances require vendor clarification, not a test that deliberately exceeds allowance. |
| Source of truth for preferences; dispatch timing; failure/retry behavior | Integration design. Public APIs establish the options; this note selects none. |
| Cadence SSR/hydration, reconnects, user switching, feed counts, persisted toggles, forged writes, mandatory delivery, history/no-replay cases | Live implementation verification after provisioning. Documentation is not runtime proof, but these are not unidentified planning facts requiring an account now. |
| Final vendor commitment | Human vendor decision, using this evidence and the agreed acceptance conditions. No final choice is made here. |

The next conversation should establish whether attribution and Free-plan operating constraints are acceptable selection conditions, and whether final commitment is conditional on implementation verification. Keep signup deferred until a concrete live integration check is authorized and ready to run. No paid plan or new delivery policy follows from this research.
