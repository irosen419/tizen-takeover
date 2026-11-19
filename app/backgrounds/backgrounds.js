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
 * ?bg=day/3 or ?bg=night/0 on the address forces entry 3 of the day list or
 * entry 0 of the night list (counting from 0), for screenshots and testing.
 */
var HUB_BACKGROUNDS = {
  day: [
    { file: 'backgrounds/ocean.jpg', title: 'Ocean', credit: 'placeholder picture' }
  ],
  night: [
    { file: 'backgrounds/ocean.jpg', title: 'Ocean', credit: 'placeholder picture' }
  ]
};
