import { CONSTANTS } from "@runa/core";

// Phase S builds the real UI (population controls, constant sliders, charts).
// This shell only proves the workspace wiring: simlab consumes the same core
// package the client ships.
const app = document.getElementById("app")!;
app.innerHTML = `
  <main style="font-family: system-ui; max-width: 640px; margin: 2rem auto; padding: 0 1rem">
    <h1>Runa simlab</h1>
    <p>Simulator shell. Reference constants loaded from <code>@runa/core</code>:</p>
    <pre>${JSON.stringify(CONSTANTS, null, 2)}</pre>
  </main>
`;
