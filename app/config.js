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
 *   webhook    asks Home Assistant to do something (POSTs to a webhook url)
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
        /* The TV won't let the hub press keys itself, so Home Assistant (already trusted by the TV)
           switches the input. Put the Home Assistant address in url, e.g.
           'http://192.168.1.50:8123/api/webhook/tv-switch-to-xbox' */
        { kind: 'webhook', label: 'Xbox', sub: 'HDMI 1', busy: 'Switching to the Xbox', url: '',
          hint: 'Press the Xbox button on your controller. With Anynet+ on, the TV switches to HDMI 1 by itself.', tone: 'green' }
      ]
    },
    {
      label: 'Free TV',
      tiles: [
        { kind: 'app', label: 'Pluto TV', match: ['Pluto TV', 'Pluto'], tone: 'amber' },
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
