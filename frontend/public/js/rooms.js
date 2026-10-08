$(function () {
  $.ajaxSetup({ timeout: 4000 });
  let lastDevices = '';

  function loadDevices() {
    $.getJSON('/api/devices').done(function (devices) {
      const signature = JSON.stringify(devices);
      if (signature === lastDevices) return;
      lastDevices = signature;
      const $list = $('#device-list').empty();
      $('#room-message').text(devices.length ? '' : 'No rooms are registered yet.');
      devices.forEach(function (device) {
        const $copy = $('<div>').addClass('room-copy').append(
          $('<span>').addClass('room-symbol').attr('aria-hidden', 'true').text('▦'),
          $('<div>').append($('<h2>').text(device.name), $('<p>').text(device.location || device.device_uid))
        );
        const $footer = $('<div>').addClass('room-card-footer').append(
          $('<span>').addClass('room-device-status').addClass(device.device_online ? 'online' : 'offline')
            .text(device.device_online ? 'Online' : 'Offline'),
          $('<a>').addClass('open-room').attr('href', `/dashboard?device_uid=${encodeURIComponent(device.device_uid)}`).text('Open Dashboard')
        );
        $list.append($('<article>').addClass('room-card').append($copy, $footer));
      });
    }).fail(function (xhr) {
      if (xhr.status === 401) return window.location.assign('/login');
      lastDevices = '';
      $('#device-list').empty();
      $('#room-message').text('Room list unavailable. Retrying automatically…');
    });
  }

  loadDevices();
  window.setInterval(loadDevices, 5000);
});
