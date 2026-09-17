export function get_runtime_memory(): number {
  return process.memoryUsage().rss;
}