# omp-background

Client-only example plugin that adds a composer pill to OMP agents while they
have background work pending.

The daemon's OMP provider emits a synthetic timeline row (`callId
omp-background-work`) when a run ends as a yield to a still-pending background
job, and re-emits the same row terminal when the session settles, when the OMP
process exits, or when the session closes. This pill watches those omp agents'
timelines and shows "Background work" in the composer track while the row reads
`running`. Because the row is daemon-owned, an omp reload or daemon restart
clears the pill without any client-side cleanup.

Install locally:

```bash
paseo plugin install /absolute/path/to/paseo/plugin-examples/omp-background
```
