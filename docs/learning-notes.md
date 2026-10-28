# From a laptop inference service to production infrastructure

These are study notes and a future experiment plan. Only Node.js, Ollama and the CPU benchmark were implemented and run. The original numbered blog URLs were not available in the chat-reading tool, so the sources below are official substitutes. The earlier ChatGPT checklist records the author's report that Blog 1 was already read.

## Request lifecycle and the API boundary

The client sends chat messages; the backend applies a model-specific chat template and tokenizes the prompt. **Prefill** computes prompt representations and builds the attention key/value cache. **Decode** then produces successive output tokens while reusing cached keys and values. Queueing can happen before the first generated text, and load time can appear when the model is not resident.

The gateway operates at the HTTP boundary. It enforces admission and forwards streaming output. Model execution, batching, tokenization and KV-cache management belong to the inference backend. Async Node request handling does not make matrix operations run in parallel.

[Ollama's compatibility guide](https://docs.ollama.com/api/openai-compatibility) and [vLLM's online serving docs](https://docs.vllm.ai/en/latest/serving/online_serving/) document a common API surface, including `/v1/chat/completions`. That makes a backend migration practical for this text-only subset. Compatibility must still be checked for token accounting, templates and supported fields; the entire APIs are not interchangeable.

## vLLM: batching and KV-cache management

The [original vLLM PagedAttention article](https://vllm.ai/blog/2023-06-20-vllm) explains how allocating KV-cache blocks on demand reduces wasted cache capacity and allows more concurrent sequences to fit in memory. Logical sequence blocks need not occupy contiguous physical memory. These memory-management choices matter because increasing the batch needs room for active sequences' caches as well as model weights.

Continuous batching can admit and retire sequences as generation proceeds instead of requiring a fixed batch to finish as a group. It is an engine scheduling capability. Accepting concurrent HTTP requests at a gateway, as this project does, is not evidence that an engine used continuous batching. No vLLM throughput claim is derived from this laptop run, and the original article's historical GPU results are not reused as our benchmarks.

## Kubernetes GPU scheduling

[Kubernetes GPU scheduling](https://kubernetes.io/docs/tasks/manage-gpus/scheduling-gpus/) describes the device-plugin path: the node needs the vendor driver and a device plugin; that plugin exposes an extended resource such as `nvidia.com/gpu`. A Pod can request one GPU through its limits. Explicit GPU requests must equal GPU limits. Node labels and affinity can select a suitable GPU class.

The scheduler allocates resources and places Pods. It does not infer whether a particular model, precision and context length will fit in GPU memory. A resource count of one GPU is not a substitute for a memory budget or a benchmark. No cluster or GPU device plugin was installed for this project.

## NVIDIA GPU Operator

The [GPU Operator overview](https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/overview.html) describes automation of the NVIDIA node software stack: drivers, Container Toolkit, device plugin, node labeling and DCGM-based monitoring. The Operator helps provision a working GPU node environment; it is not the model inference engine or the gateway.

On this AMD laptop, installing NVIDIA components would not supply an NVIDIA GPU. This topic is a production infrastructure connection, not an installation step performed here.

## DCGM and service observability

[DCGM Exporter](https://docs.nvidia.com/datacenter/dcgm/latest/installation/install-dcgm-exporter.html) exposes NVIDIA telemetry in Prometheus format. GPU utilization and framebuffer memory usage are examples of device measurements. In a real GPU service I would correlate them with queue depth, active requests, TTFT and output throughput, then inspect traces or profiles before naming the bottleneck.

For this run, the available evidence is Windows process CPU and working-set sampling plus gateway timings. It is not DCGM telemetry. CPU utilization confirms activity; it alone does not establish whether the limiting resource was arithmetic, memory bandwidth or power management.

## Why KServe exists

[KServe's introduction](https://kserve.github.io/website/docs/intro) explains its model-serving control plane, custom resources and pluggable runtimes. It handles model-serving lifecycle and operational concerns above individual inference processes. Depending on deployment mode and configuration, its ecosystem supports scaling, routing and rollouts.

KServe does not replace vLLM's token-generation engine. The useful distinction is between managing replicas and managing sequences inside a replica. Autoscaling also needs time for model loading and warm-up; this laptop's cold/warm observation is a small illustration of why readiness and resident capacity matter. No KServe deployment or autoscaling behavior was tested here.

## Next experiment: vLLM

On a supported Linux GPU host, first record the GPU, VRAM, driver, CUDA and exact vLLM version, and check the current installation requirements. The following is a **proposed command, not a command run in this project**:

```bash
vllm serve Qwen/Qwen2.5-0.5B-Instruct \
  --served-model-name inference-lab:qwen05-cpu \
  --max-model-len 2048 --host 127.0.0.1 --port 8000
```

The alias preserves the existing client's model field; rename it for a separate GPU study to avoid confusion. The flag is documented in [vLLM's serve reference](https://docs.vllm.ai/en/latest/cli/serve/). Set the gateway's `UPSTREAM_BASE_URL` to the vLLM `/v1` URL, using a private route or SSH tunnel for a remote host. A local unexposed instance needs no cloud API key.

Replace the harness's Ollama-specific unload, metadata and native-timing calls before measuring vLLM. Confirm streaming usage accounting and templates. Record precision: the proposed default Hugging Face weights differ from this run's Q4_K_M GGUF, so an unqualified backend speed comparison would be misleading. Keep workload and precision comparable or disclose the differences.

Then vary engine concurrency, prompt length, output length and offered request rate. Record both queueing latency and throughput. Test a second engine parallelism setting before inferring the limits of Ollama, and compare vLLM's scheduling behavior only from traces and measurements actually collected there.

## Questions to answer before sharing the article

1. Where can TTFT accumulate before the first text reaches the client?
2. Why did three accepted streams not triple throughput in this run?
3. How do model residency and prompt-cache reuse separately affect warm-up?
4. What does an OpenAI-compatible endpoint allow us to swap, and what does it not guarantee?
5. Which problem belongs to the gateway, the inference engine, the Kubernetes scheduler, the GPU Operator and KServe?
6. What measurements would distinguish compute pressure from memory-bandwidth pressure?
7. Why are 30 warm requests insufficient to claim a production p99 latency?

The article should reflect the author's answers and actual understanding before being used in an interview or job application.
