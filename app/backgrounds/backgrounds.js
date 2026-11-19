/*
 * The pictures behind the tiles when HUB_CONFIG.background is 'auto'
 * (see app/config.js and "Backgrounds" in the README).
 *
 * One list for the day look and one for the night look. The hub shows
 * list[dayNumber % list.length], where dayNumber counts the days since 1970
 * on the TV's local date: a new picture each day, and day and night differ.
 *
 *   file    the picture, next to hub.html (put day pictures in
 *           app/backgrounds/day and night ones in app/backgrounds/night)
 *   title   what it shows, as the About panel's "Picture" row says it
 *   credit  who made it and under what licence
 *
 * base      (optional, below) put before every file that is not a full web
 *           address, so one line moves all the pictures to another host,
 *           e.g. 'https://cdn.jsdelivr.net/gh/owner/repo@backgrounds/'.
 *           A file that starts with http:// or https:// is used as it is.
 *           Pictures from another site must send Access-Control-Allow-Origin
 *           (jsDelivr does), or the tiles lose their glass window.
 *
 * ?bg=day/3 or ?bg=night/0 on the address forces entry 3 of the day list or
 * entry 0 of the night list (counting from 0), for screenshots and testing.
 */
var HUB_BACKGROUNDS = {
  base: '',
  day: [
    { file: 'backgrounds/ocean.jpg', title: 'Ocean', credit: 'placeholder picture' }
  ],
  night: [
    { file: 'backgrounds/ocean.jpg', title: 'Ocean', credit: 'placeholder picture' }
  ]
};
