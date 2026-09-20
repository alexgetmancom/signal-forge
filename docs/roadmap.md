# Roadmap

## Next work

Ordered by reader value. Every measurement here is dated, because a priority derived from a number
that has since moved is not a priority.

| Priority | Task | Definition of done |
|---|---|---|
| Next | Read `news` back in a week. | `channel-mix 7`, taken no earlier than 2026-09-24, says what the two channels carried after the widening of 2026-09-17 (`news`: `launch`, `change`, `release`, `retirement`, `feature`, `debut`, `safety`, `research`; `radar`: `codename`). Done when the real numbers per class are written here with their date, and every class or source that produced cards the owner calls noise is taken off `news` with its count. |
| Next | Judge the sources a month in. | `source-verdicts 30`, first taken no earlier than 2026-10-17 so the trending list, the media arenas and Hacker News have a whole period behind them. It names every enabled source that over thirty days led no other source, reached no reader and drew no reader vote. Done when each one named is removed or kept with a one-line reason here, and the date of the next reading is written in its place. |
| Next | Read the corroboration threshold back. | The threshold of three unrelated sources fired four times in the week to 2026-09-20 and delivered nothing: every card was silenced again by the per-event rules inside batching, and every subject was old -- Grok 4.3 (17 April 2026), Grok 4.6 and Qwen3.8-2.4T-A95B (12 August), Ling-3.0-flash (23 July). Three registries finishing the same import is their news, not the model's. On 2026-09-21 the count was made to require that the subject be new to us -- first seen inside the same 72-hour window, with no source carrying an older creation date -- and the card it raises now bypasses the per-event reasons, which were never asked about the accumulation. Step 5 Preview, the one true case, gathered its three inside a day and still passes. `passed-over 7`, taken no earlier than 2026-09-28, says whether the narrowed rule still catches anything and what it now leaves silent; `passed-over 30` after 2026-10-21 ranks the rules that kept subjects quiet, `already_told_by_another_source` among them -- which did not appear once in the week to 2026-09-20, where every silence came from `no_reader_facing_change`. Done when both readings are written here with their dates, and the window and that rule are moved or kept with a reason. |

| After the reactions | Read Jev back against the readers, and decide what `confidence` is for. | Jev answers every judgement with a confidence we store and never read: across 2418 judgements on 2026-09-21 the mean worth was flat from confidence 0.3 to 0.9 (1.10--1.29) and only the 678 held at 1.0 stood out at 1.46. There is nothing to choose between weighting by it and refusing under a floor while the only opinion on a card is Jev's own. Since 2026-09-20 `scout_reactions` separates silence from 👍 and from 👎; the first two days seeded 105 cards and drew 6 votes, four of them on recaps that carry no judgement at all, so on 2026-09-21 the seeding window went from 12 hours to seven days and the per-pass cap from 20 to 60. Done when at least fifty **judged** cards carry a reader's answer, worth and confidence are correlated against those answers here with their date, and `confidence` is either given a use or written off. |

| Owner decision | AWS: an account for Bedrock and its quotas. | The Vertex pair is the model: Vertex quotas named `grok-4.7` on 2026-09-17 while Model Garden's newest xAI entry was `grok-4.6`. Bedrock's counterparts are `ListFoundationModels` and `ListInferenceProfiles` in `us-east-1` and `us-west-2`, and Service Quotas for service code `bedrock`, whose per-model token limits may likewise run ahead of the listing. Reading them is free; the account needs a card. Done when an IAM user holding only those three read actions has its keys in production and both collect. |
| Owner decision | Azure: a subscription for AI Foundry. | `Microsoft.CognitiveServices/locations/{region}/models` is the deployable catalogue per region and `usages` the per-model quota; today Azure is seen only second-hand, through the TrueFoundry mirror and the lifecycle page. A pay-as-you-go subscription costs nothing unused. Done when a service principal with Reader has its tenant, client id and secret in production and both collect. |
| Owner decision | Kimi: a key for the coding tier. | The Moonshot key answers with `kimi-k2.6` and `kimi-k2.7-code` and nothing newer, checked against production 2026-09-14, which is why the K2.8 Preview rollout of 11 September 2026 was invisible here. The coding tier is a separate host with a separate credential: `api.kimi.com/coding/v1/models` answers 401 to a key it does not accept while every neighbouring path answers 404, so the source is registered and correct ahead of the key. Set `KIMI_API_KEY` and it collects; the Kimi Code changelog already ships as its own source. |

## Ideas

Not scheduled. Written down so they stop being re-derived from scratch.

- **Hosts of open models.** NVIDIA NIM (`integrate.api.nvidia.com/v1/models`), Together, Fireworks
  and DeepInfra list a model in `/v1/models` when they start serving it, often ahead of the
  announcement. Each needs a free key and would reach readers as a sighting only. NVIDIA first:
  it is the one that tends to be early. GitHub Models is not a candidate: its catalogue answered
  `410 github_models_retirement_brownout` on 2026-09-17.
