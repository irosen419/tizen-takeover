/*
 * Guest mode: hides every money figure on this TV while guests are over.
 *
 *   HUB_GUEST.on()           true while Guest mode is on
 *   HUB_GUEST.set(bool)      turns it on or off; remembered on this TV
 *   HUB_GUEST.onChange(fn)   fn(on) after every change
 *   HUB_GUEST.MONEY          the widgets that show money
 *   HUB_GUEST.hasMoney(list) true if a layout puts any of them on screen
 *
 * What it does (each part lives with its widget):
 *   awws.js     Earned vs spent says "Hidden for guests"; the Glance drops its
 *               money line.
 *   budget.js   the budget tiles say "Hidden for guests", the "New charge"
 *               banner never shows, and the budget the Pi sends is dropped as
 *               it arrives. The copy this TV kept is deleted.
 *   budget-lab.js  Budget lab says "Hidden for guests" and forgets its
 *               session (the cap being tried); the saved cap stays, hidden.
 *   investments.js  the one tile that does NOT say "Hidden for guests": it
 *               shows percentages only (gain, shares, the trend's shape) and
 *               keeps no dollar. It is not in MONEY, so a layout with it
 *               stays in the switcher.
 *   hub.js      the money layouts leave the layout bar; a money layout on
 *               screen gives way to the first layout without money.
 *   today.js    the Guest mode Off / On choice on the Clock page.
 *
 * Off unless turned on. Calendars and to-dos are not affected. Loads before
 * the widgets. Plain ES5 for the TV's browser.
 */
(function () {
  'use strict';

  var KEY = 'homeHub.guest.v1';
  var MONEY = ['awws-money', 'budget-room', 'budget-card', 'budget-goals', 'budget-lab'];
  var state = false;
  var listeners = [];

  try { state = !!(window.localStorage && window.localStorage.getItem(KEY) === 'on'); } catch (e) { state = false; }

  function set(next) {
    next = !!next;
    if (next === state) return;
    state = next;
    try {
      if (window.localStorage) {
        if (state) window.localStorage.setItem(KEY, 'on');
        else window.localStorage.removeItem(KEY);
      }
    } catch (e) { /* kept for this visit only */ }
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](state); } catch (e) {
        try { if (window.console && console.warn) console.warn('Guest mode: ' + (e && e.message)); } catch (e2) { /* ignore */ }
      }
    }
  }

  function hasMoney(list) {
    if (!list || Object.prototype.toString.call(list) !== '[object Array]') return false;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && MONEY.indexOf(list[i].widget) >= 0) return true;
    }
    return false;
  }

  window.HUB_GUEST = {
    MONEY: MONEY.slice(),
    on: function () { return state; },
    set: set,
    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); },
    hasMoney: hasMoney
  };
})();
