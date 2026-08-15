# Vendored assets

`chart.umd.min.js` — Chart.js v4.5.1 (MIT, see `chart.js-LICENSE.md`), the UMD
build taken verbatim from the npm tarball (`npm pack chart.js@4`).

It is committed rather than fetched from a CDN because this dashboard is meant
to run on a LAN box with no outbound access beyond api.github.com. Loading it
from jsdelivr made the Trends view render a blank chart frame, with no error, on
any host without egress — and leaked a request to a third party on every page
view.

To update: `npm pack chart.js@4`, copy `package/dist/chart.umd.min.js` here,
refresh this note and the licence file.
