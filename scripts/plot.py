"""Static figures generated only from saved benchmark evidence. Requires matplotlib."""
import json
import pathlib
import statistics
import sys
from datetime import datetime

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

run = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'results/baseline')
summary = json.loads((run / 'summary.json').read_text(encoding='utf-8-sig'))
rows = [json.loads(line) for line in (run / 'requests.jsonl').read_text(encoding='utf-8-sig').splitlines() if line.strip()]
samples = [json.loads(line) for line in (run / 'host-samples.jsonl').read_text(encoding='utf-8-sig').splitlines() if line.strip()]
valid_samples = [sample for sample in samples if sample['inference_cpu_percent_of_machine'] is not None]
cpu = [sample['inference_cpu_percent_of_machine'] for sample in valid_samples]
host_summary = {
    'sample_count': len(cpu), 'mean_inference_cpu_percent_of_machine': statistics.mean(cpu),
    'median_inference_cpu_percent_of_machine': statistics.median(cpu),
    'max_inference_cpu_percent_of_machine': max(cpu),
    'max_inference_working_set_mib': max(sample['inference_working_set_bytes'] for sample in valid_samples) / 1024**2,
    'note': 'Sum of ollama and llama-server process CPU deltas, normalized by the recorded logical CPU count; includes idle boundaries and native probes. Working sets can include shared pages.'
}
(run / 'host-summary.json').write_text(json.dumps(host_summary, indent=2) + '\n', encoding='utf-8')

plt.rcParams.update({'font.family': 'DejaVu Sans', 'font.size': 10, 'axes.spines.top': False, 'axes.spines.right': False, 'svg.fonttype': 'none'})
fig, axes = plt.subplots(1, 3, figsize=(13.2, 4.5))
blue = '#245d85'
for index, (field, title) in enumerate([('ttft_ms', 'Client time to first generated text'), ('latency_ms', 'Client total response latency')]):
    ax = axes[index]
    for concurrency in [1, 2, 3]:
        values = [row[field] / 1000 for row in rows if row['phase'] == 'warm' and row['concurrency'] == concurrency and row['status'] == 'ok']
        offsets = [(i - (len(values) - 1) / 2) * 0.018 for i in range(len(values))]
        ax.scatter([concurrency + offset for offset in offsets], values, color=blue, alpha=.6, s=20)
        ax.plot([concurrency-.18, concurrency+.18], [statistics.median(values)]*2, color='black', linewidth=2)
    ax.set(title=title, xlabel='Simultaneous client requests', ylabel='Time (seconds)', xticks=[1, 2, 3], ylim=(0, None))
    ax.grid(axis='y', alpha=.2)
ax = axes[2]
values = [group['wave_aggregate_tokens_per_second']['median'] for group in summary['warm']]
ax.bar([1, 2, 3], values, color=blue, width=.52)
for c, value in zip([1, 2, 3], values):
    ax.text(c, value + .65, f'{value:.1f}', ha='center')
ax.set(title='Median aggregate output throughput', xlabel='Simultaneous client requests', ylabel='Completion tokens / second', xticks=[1, 2, 3], ylim=(0, 44))
ax.grid(axis='y', alpha=.2)
metadata = summary['metadata']
date_label = datetime.fromisoformat(metadata['started_at'].replace('Z', '+00:00')).strftime('%d %b %Y')
source_label = f"Source: {run.as_posix()}, {date_label} · {metadata['rounds']} waves per level · {metadata['max_tokens']} output-token cap"
counts = '/'.join(str(group['requests']) for group in summary['warm'])
fig.suptitle('Client latency and aggregate output throughput under concurrent requests', x=.06, ha='left', fontsize=13)
fig.text(.06, .025, source_label + f"\nDots: individual requests. Black lines: medians. Warm n={counts}. Model: {metadata['model']}. Settings: metadata and Modelfile.", fontsize=8.5)
fig.tight_layout(rect=(.025, .14, .99, .92))
fig.savefig(run / 'concurrency.png', dpi=180)
fig.savefig(run / 'concurrency.svg')
plt.close(fig)

fig, ax = plt.subplots(figsize=(7.2, 4))
values = [summary['cold']['ttft_ms'] / 1000, summary['warm_immediate']['ttft_ms'] / 1000]
ax.bar(['Model unloaded', 'Immediate warm repeat'], values, color=[blue, '#799aaa'], width=.55)
for i, value in enumerate(values):
    ax.text(i, value + .035, f'{value:.3f} s', ha='center')
ax.set(title='First generated text: model-cold versus immediate warm repeat', ylabel='Client TTFT (seconds)', xlabel='Model state (one observation each)', ylim=(0, max(values)*1.2))
ax.grid(axis='y', alpha=.2)
fig.text(.1, .015, f'Source: {run.as_posix()}, {date_label}. Same prompt; OS file cache not flushed.\nWarm request can reuse prompt KV cache. This does not isolate model loading alone.', fontsize=8.5)
fig.tight_layout(rect=(0, .11, 1, 1))
fig.savefig(run / 'cold-warm.png', dpi=180)
fig.savefig(run / 'cold-warm.svg')
plt.close(fig)
print(json.dumps(host_summary, indent=2))
