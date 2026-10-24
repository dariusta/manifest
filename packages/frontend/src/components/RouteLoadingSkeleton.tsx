import { For, type Component } from 'solid-js';

const RouteLoadingSkeleton: Component = () => (
  <div class="container--lg" role="status" aria-label="Loading page" aria-busy="true">
    <div class="page-header">
      <div class="skeleton skeleton--text" style="width: 220px; height: 28px;" />
    </div>
    <div class="agents-grid">
      <For each={[1, 2, 3, 4, 5, 6]}>
        {() => (
          <div class="agent-card agent-card--skeleton">
            <div class="skeleton skeleton--text" style="width: 60%; height: 20px;" />
            <div
              class="skeleton skeleton--text"
              style="width: 80%; height: 14px; margin-top: 16px;"
            />
          </div>
        )}
      </For>
    </div>
  </div>
);
export default RouteLoadingSkeleton;
