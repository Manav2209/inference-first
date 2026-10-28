# Experiment protocol and interpretation

## Machine and engine

The baseline was collected on 28 October 2026. Exact UTC start and end timestamps are in `results/baseline/metadata.json`.

- Windows 11, AMD Ryzen 3 5300U: four physical cores, eight logical processors.
- 8 GB installed RAM; Windows reports 7.33 GiB usable. Approximately 1.68 GiB was available at the host snapshot before this run.
- Integrated AMD Radeon graphics were present. The model was explicitly forced onto the CPU with `num_gpu=0`; `/api/ps` recorded `size_vram=0`.
- Ollama 0.40.12, Node v22.13.1.
- `qwen2.5:0.5b`, 494.03M parameters, GGUF Q4_K_M. Download about 397 MB; model working allocation reported by Ollama about 438 MiB.
- Derived model `inference-lab:qwen05-cpu`: context 2048, four CPU threads, temperature 0, seed 42.
- One Ollama inference slot (`OLLAMA_NUM_PARALLEL=1`), maximum three inflight requests at the gateway.

`host.json`, `model.json`, `models.json`, `after-warm.json`, `server-evidence.txt` and the versioned `Modelfile` preserve the evidence. The measured model manifest digest was `405e8f1b2543091702b025ed2b4e4ca35bc7ae682cf3175df7d07fc507c20057`.

## Sequence

1. Capture hardware metadata. Start process CPU/working-set sampling at approximately one-second intervals.
2. Unload the model via Ollama's native API and verify it is absent from `/api/ps`.
3. Send one streamed request through the gateway. Label it **model-cold**. The model file may still be in Windows' filesystem cache.
4. Repeat the same request immediately. Label it **warm-immediate**. Both model residency and prompt cache state may differ from the previous request.
5. Send one separate warm-up request, excluded from measured groups.
6. Run five closed-loop waves per concurrency level. Rotate the level order across rounds: `[1,2,3]`, `[3,1,2]`, `[2,3,1]`. Each wave starts all its requests together and waits for every request to finish before starting the next wave. Prompts rotate over the three saved inputs.
7. Save the loaded model's residency information.
8. Unload again and perform two nonstreaming **native Ollama API** probes, cold and warm, to obtain engine load, prompt evaluation and decode durations. These are separate observations, not timings for the earlier streamed requests.
9. Save the finished timestamp, aggregate results and CSV. Stop the sampler.

Each measured request asks for a detailed answer and caps generation at **96 output tokens**. All 32 measured streaming requests reached that cap (`finish_reason=length`). Their answers are intentionally incomplete. This controls output length; it does not establish model quality. Even temperature 0 plus a fixed seed did not produce byte-identical native cold/warm answers on this run.

## Metric definitions

**Client TTFT:** elapsed time from just before `fetch` to the first nonempty `choices[].delta.content` observed after parsing a complete SSE event. Headers and role-only events do not count. This is first visible text; a chunk may contain multiple model tokens.

**Total latency:** request start to the end of the fully consumed HTTP response. The harness requires generated text, a finish reason, `[DONE]` and provider-reported completion token usage before accepting a request as successful.

**Per-request end-to-end output rate:** provider-reported completion tokens divided by total request latency. This includes queueing, prompt evaluation and transport. It is not an isolated decoder benchmark.

**Wave aggregate throughput:** sum of completion tokens from successful requests in a wave divided by the actual wall time of that wave. The summary reports the median across the five waves. It never sums individual request rates.

**Engine decode rate:** `eval_count / (eval_duration / 1e9)` from a separate native Ollama probe. This rate excludes load and prompt evaluation and is not interchangeable with client throughput.

**CPU utilization:** sum of process CPU-time deltas for `ollama` and `llama-server`, divided by sample duration and eight logical CPUs. Four busy threads can correspond to approximately 50% of total logical CPU capacity. This sampling does not identify whether computation, memory bandwidth, frequency scaling or another CPU-side resource is the dominant bottleneck.

## Saved baseline

Warm groups contain 5, 10 and 15 requests at concurrency 1, 2 and 3, respectively. All groups contain five waves. There were no request failures.

- Concurrency **1**: median TTFT **60.6 ms** (54.1–66.0 ms); median total latency **2.582 s**; median aggregate throughput **37.18 tokens/s**.
- Concurrency **2**: median TTFT **1,318.9 ms** (59.1–2,683.6 ms); median total latency **3.866 s**; median aggregate throughput **37.65 tokens/s**.
- Concurrency **3**: median TTFT **2,615.5 ms** (70.7–5,475.2 ms); median total latency **5.152 s**; median aggregate throughput **37.07 tokens/s**.

At concurrency 2 the median averages two middle observations from distinct fast/queued groups; it need not represent a typical individual request. At concurrency 3 the raw events show one request starting promptly, a second roughly 2.6 seconds later, and a third roughly 5.2 seconds later. Client submission order does not guarantee engine service order.

The first model-cold streamed TTFT was **2,083.8 ms**, versus **55.0 ms** for the immediate warm repeat. Corresponding full response times were approximately **4.532 s** and **2.587 s**.

The separate native probes reported:

- Cold: **1.407 s load**, **0.634 s prompt evaluation**, **2.701 s decoding**, **35.55 decode tokens/s**; **0/69 prompt tokens cached**.
- Warm: **0.010 s load**, **0.063 s prompt evaluation**, **2.848 s decoding**, **33.70 decode tokens/s**; **68/69 prompt tokens cached**.

This supports the interpretation that both loading and prompt-cache reuse affected the cold/warm difference. Two probes do not quantify their contributions to the earlier streamed TTFT difference.

## Limits on conclusions

These measurements demonstrate queueing in this specific single-slot CPU configuration. They do not show that all Ollama configurations serialize requests, compare Ollama to vLLM, or measure GPU continuous batching. Windows' cache was not flushed; background desktop applications remained active; input prompts were short and reused; only one small quantized model and one output length were tested. Five waves per level do not support reliable production tail-latency or SLO claims.

Reproduction means rerunning the saved method and inspecting the same metrics. It does not mean another run will produce identical text or timing.

## Manual equivalent of the launcher

After pulling the base model, use one PowerShell window for Ollama:

```powershell
$env:OLLAMA_HOST = '127.0.0.1:11435'
$env:OLLAMA_NUM_PARALLEL = '1'
$env:OLLAMA_MAX_LOADED_MODELS = '1'
$env:OLLAMA_CONTEXT_LENGTH = '2048'
$env:OLLAMA_KEEP_ALIVE = '5m'
ollama serve
```

In another PowerShell window, from the repository root:

```powershell
$env:OLLAMA_HOST = '127.0.0.1:11435'
ollama create inference-lab:qwen05-cpu -f Modelfile
$env:UPSTREAM_BASE_URL = 'http://127.0.0.1:11435/v1'
node src/server.mjs
```

In a third window:

```powershell
$env:OLLAMA_URL = 'http://127.0.0.1:11435'
$env:RESULTS_DIR = 'results/manual-run'
node bench/run.mjs
node bench/summarize.mjs results/manual-run
```

That manual path omits Windows CPU sampling unless `scripts/sample-host.ps1` is run separately. Do not use `plot.py`'s host summary for a run without the sampler evidence.
