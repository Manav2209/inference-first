# Publication package

The article is in [blog.md](blog.md). Figures and raw evidence are linked using repository-relative paths so GitHub renders them. Before copying to another platform, upload the two PNG figures and replace relative image and evidence links with published URLs.

Review the article's first-person explanations against your own understanding. The measurements were collected on this computer using coding assistance. The study questions in `learning-notes.md` are a useful interview check. The evidence supports CPU Ollama observations; it does not support claims of deploying or benchmarking vLLM, GPUs or Kubernetes.

## X post draft

I built a streaming LLM gateway on my 8GB laptop. With one Ollama inference slot, going from 1 to 3 clients raised median TTFT from 61ms to 2.62s while throughput stayed near 37 tokens/s. Code, raw results and what I learned about serving infrastructure:

Append the published repository/article link before posting. This draft has not been sent to X.

## Job application description

Built a Node.js gateway for local LLM inference with SSE streaming, cancellation, deadlines and admission control. Designed a reproducible CPU benchmark showing how client concurrency affected TTFT and throughput, and documented the distinction between API gateways, inference engines and Kubernetes serving infrastructure.

Use this description after reviewing the implementation and results so you can explain the choices in an interview.
