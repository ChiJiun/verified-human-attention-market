/**
 * Minimal Prometheus-compatible metrics registry (text exposition format
 * 0.0.4). No dependency; counters and gauges with string labels only.
 */

type Labels = Record<string, string>;

interface Series {
  labels: Labels;
  value: number;
}

interface Metric {
  name: string;
  help: string;
  type: "counter" | "gauge";
  series: Map<string, Series>;
}

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

function labelKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`)
    .join(",");
}

function escapeLabel(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"');
}

export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric>();

  private metric(name: string, help: string, type: Metric["type"]): Metric {
    if (!NAME.test(name)) {
      throw new Error(`Invalid metric name ${name}`);
    }

    const existing = this.metrics.get(name);
    if (existing) {
      return existing;
    }

    const created: Metric = { name, help, type, series: new Map() };
    this.metrics.set(name, created);
    return created;
  }

  counter(name: string, help: string) {
    const metric = this.metric(name, help, "counter");
    return {
      inc: (labels: Labels = {}, amount = 1) => {
        const key = labelKey(labels);
        const series = metric.series.get(key) ?? { labels, value: 0 };
        series.value += amount;
        metric.series.set(key, series);
      },
    };
  }

  gauge(name: string, help: string) {
    const metric = this.metric(name, help, "gauge");
    return {
      set: (value: number, labels: Labels = {}) => {
        metric.series.set(labelKey(labels), { labels, value });
      },
    };
  }

  /** Current value, for tests and in-process checks. */
  value(name: string, labels: Labels = {}): number {
    return this.metrics.get(name)?.series.get(labelKey(labels))?.value ?? 0;
  }

  render(): string {
    const lines: string[] = [];

    for (const metric of this.metrics.values()) {
      lines.push(`# HELP ${metric.name} ${metric.help}`);
      lines.push(`# TYPE ${metric.name} ${metric.type}`);

      for (const series of metric.series.values()) {
        const labels = Object.entries(series.labels)
          .sort(([left], [right]) => (left < right ? -1 : 1))
          .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
          .join(",");
        lines.push(
          `${metric.name}${labels ? `{${labels}}` : ""} ${series.value}`,
        );
      }
    }

    return `${lines.join("\n")}\n`;
  }
}
