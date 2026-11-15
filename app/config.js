/*
 * Home Hub tiles. Edit this file to change what shows on the TV.
 *
 * Each app tile finds its app on the TV by name, so no app IDs are needed.
 * "match" is a list of names to look for (case does not matter). The first
 * installed app whose name equals or contains one of them is used.
 *
 * Tile kinds:
 *   app        opens an installed TV app
 *   tizentube  opens TizenTube through TizenBrew
 *   input      switches the TV to an input (sends a remote key)
 *   dashboard  opens a web page full screen inside the hub (Back returns)
 *   allApps    lists every app on the TV
 */
var HUB_CONFIG = {
  title: 'Living room',
  rows: [
    {
      label: 'Watch',
      tiles: [
        { kind: 'app', label: 'Netflix', match: ['Netflix'], tone: 'red' },
        { kind: 'app', label: 'Prime Video', match: ['Prime Video', 'Amazon Prime Video', 'Amazon'], tone: 'blue' },
        { kind: 'app', label: 'Disney+', match: ['Disney+', 'Disney Plus', 'Disney'], tone: 'indigo' },
        { kind: 'app', label: 'Hulu', match: ['Hulu'], tone: 'green' },
        { kind: 'app', label: 'Peacock', match: ['Peacock TV', 'Peacock'], tone: 'amber' },
        { kind: 'app', label: 'Apple TV', match: ['Apple TV', 'Apple TV+'], tone: 'slate' },
        { kind: 'tizentube', label: 'YouTube', sub: 'TizenTube, no ads', tone: 'red' }
      ]
    },
    {
      label: 'Play',
      tiles: [
        { kind: 'input', label: 'Xbox', sub: 'HDMI 1', key: 'KEY_HDMI1', tone: 'green' }
      ]
    },
    {
      label: 'Free TV',
      tiles: [
        /* On this TV, Samsung TV Plus lives inside Live TV ("TV app") rather than being its own app. */
        { kind: 'app', label: 'Samsung TV Plus', sub: 'Opens Live TV', match: ['Samsung TV Plus', 'TV Plus', 'Samsung TV+', 'TV app'], tone: 'blue' },
        { kind: 'app', label: 'Pluto TV', match: ['Pluto TV', 'Pluto'], tone: 'amber' },
        { kind: 'app', label: 'PBS', match: ['PBS Video', 'PBS'], tone: 'indigo' },
        { kind: 'app', label: 'Twitch', match: ['Twitch'], tone: 'indigo' }
      ]
    },
    {
      label: 'Dashboards',
      tiles: [
        /* Example. Replace the url with a page the TV can reach, then remove the slashes.
        { kind: 'dashboard', label: 'Home', sub: 'Home Assistant', url: 'http://192.168.1.50:8123', tone: 'indigo' }
        */
      ]
    },
    {
      label: 'More',
      tiles: [
        { kind: 'allApps', label: 'All apps', sub: 'Everything on the TV', tone: 'slate' }
      ]
    }
  ]
};
