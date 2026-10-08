$(function () {
  $.ajaxSetup({ timeout: 4000 });
  const roomQuery = new URLSearchParams(window.location.search);
  const deviceUid = roomQuery.get('device_uid');
  const labels = {
    high_temperature: 'High Temperature',
    high_humidity: 'High Humidity',
    gas_presence: 'Gas Presence',
  };
  if (!deviceUid) return window.location.assign('/rooms');
  let chart;
  let accessItems = [];
  let alertItems = [];

  function time(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString([], { dateStyle: 'short', timeStyle: 'medium' });
  }

  function row(cells, classes) {
    const $tr = $('<tr>');
    cells.forEach(function (value, index) {
      const $td = $('<td>').text(value == null || value === '' ? '—' : value);
      if (classes?.[index]) $td.addClass(classes[index]);
      $tr.append($td);
    });
    return $tr;
  }

  function showTableMessage(selector, columns, message) {
    $(selector).empty().append($('<tr>').append($('<td>').attr('colspan', columns).addClass('empty-cell').text(message)));
  }

  function handleFailure(xhr, selector, columns, emptyMessage) {
    if (xhr.status === 401) {
      window.location.assign('/login');
      return;
    }
    showTableMessage(selector, columns, emptyMessage);
  }

  function startClock() {
    const $clock = $('#current-time');
    function update() { $clock.text(new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' })); }
    update();
    window.setInterval(update, 1000);
  }

  function loadCurrent() {
    $.getJSON('/api/dashboard/current', { device_uid: deviceUid }).done(function (data) {
      const temperatureAvailable = Number.isFinite(data.temperature);
      const humidityAvailable = Number.isFinite(data.humidity);
      const dhtAvailable = temperatureAvailable && humidityAvailable;
      const dhtStatus = dhtAvailable ? 'DHT22 reading OK' : 'DHT22 unavailable';
      $('#temperature-value').text(temperatureAvailable ? `${Number(data.temperature).toFixed(1)} °C` : 'Data unavailable');
      $('#humidity-value').text(humidityAvailable ? `${Number(data.humidity).toFixed(0)}%` : 'Data unavailable');
      $('#temperature-sensor-status, #humidity-sensor-status')
        .text(dhtStatus).toggleClass('unavailable', !dhtAvailable);
      const gas = data.gas_status;
      const gasAvailable = gas === 'safe' || gas === 'detected';
      $('#gas-value').text(gas === 'safe' ? 'SAFE' : gas === 'detected' ? 'DETECTED' : 'Data unavailable');
      $('#gas-sensor-status').text(gasAvailable ? 'Gas sensor reading OK' : 'Gas sensor unavailable')
        .toggleClass('unavailable', !gasAvailable);
      $('.gas-card').toggleClass('safe', gas === 'safe').toggleClass('detected', gas === 'detected');
      $('#fan-value').text(data.fan_status ? data.fan_status.toUpperCase() : 'Data unavailable');
      const online = data.device_online === true;
      $('#device-status').text(data.device_online == null ? 'Status unavailable' : online ? 'Device Online' : 'Device Offline');
      $('#device-indicator').toggleClass('online', online).toggleClass('offline', data.device_online === false);
      $('#device-message').text(data.last_seen ? `${online ? 'Last update' : 'Device offline — showing last known readings from'} ${time(data.last_seen)}` : 'No readings have been received yet.');
    }).fail(function (xhr) {
      $('#device-indicator').removeClass('online offline');
      $('.gas-card').removeClass('safe detected');
      $('#temperature-value, #humidity-value, #gas-value, #fan-value').text('Data unavailable');
      $('#temperature-sensor-status, #humidity-sensor-status')
        .text('Sensor status unknown').addClass('unavailable');
        $('#gas-sensor-status').text('Sensor status unknown').addClass('unavailable');
      if (xhr.status === 404) {
        $('#device-message').text('No device data is available yet.');
        $('#device-status').text('No data');
      } else if (xhr.status === 401) {
        window.location.assign('/login');
      } else {
        $('#device-message').text('Device readings are temporarily unavailable.');
        $('#device-status').text('Status unavailable');
      }
    });
  }

  function loadAccess() {
    $.getJSON('/api/access', { device_uid: deviceUid, limit: 1000 }).done(function (items) {
      accessItems = items;
      renderAccess();
    }).fail(xhr => handleFailure(xhr, '#access-rows', 4, 'Access data unavailable'));
  }

  function renderAccess() {
      const selected = $('#access-filter').val() || 'all';
      const visibleItems = selected === 'all' ? accessItems : accessItems.filter(item => item.result === selected);
      const $rows = $('#access-rows').empty();
      if (!visibleItems.length) return showTableMessage('#access-rows', 4, accessItems.length ? 'No access activity matches this filter.' : 'No access activity has been recorded.');
      visibleItems.forEach(function (item) {
        const result = item.result === 'granted' ? 'Granted' : 'Denied';
        $rows.append(row([time(item.created_at), item.method?.toUpperCase(), item.user_name || '—', result],
          ['', '', '', item.result === 'granted' ? 'result-granted' : 'result-denied']));
      });
      $('#access-scroll').scrollTop(0);
  }

  function loadSnapshot() {
    $.getJSON('/api/snapshots/latest', { device_uid: deviceUid }).done(function (snapshot) {
      const $image = $('<img>').attr({ src: snapshot.file_path, alt: `Security snapshot for ${snapshot.device_name}` });
      $image.on('error', function () { $('#snapshot-frame').html('<div class="snapshot-empty"><p>Snapshot image is unavailable</p></div>'); });
      $('#snapshot-frame').empty().append($image);
      $('#snapshot-time').text(time(snapshot.captured_at));
      $('#snapshot-reason').text(snapshot.reason || '—');
      $('#snapshot-message').text(snapshot.device_name || '');
    }).fail(function (xhr) {
      if (xhr.status === 401) return window.location.assign('/login');
      $('#snapshot-frame').html('<div class="snapshot-empty"><span aria-hidden="true">▣</span><p>No camera snapshot available</p></div>');
      $('#snapshot-time, #snapshot-reason').text('—');
    });
  }

  function loadAlerts() {
    $.getJSON('/api/alerts', { device_uid: deviceUid, limit: 1000 }).done(function (items) {
      alertItems = items.filter(item => labels[item.type]);
      renderAlerts();
    }).fail(xhr => handleFailure(xhr, '#alert-rows', 4, 'Alert data unavailable'));
  }

  function renderAlerts() {
      const selected = $('#alert-filter').val() || 'all';
      const visibleItems = selected === 'all' ? alertItems : alertItems.filter(item => item.type === selected);
      const $rows = $('#alert-rows').empty();
      if (!visibleItems.length) return showTableMessage('#alert-rows', 4, alertItems.length ? 'No alerts match this filter.' : 'No alerts have been recorded.');
      visibleItems.forEach(function (item) {
        const $tr = row([time(item.created_at), labels[item.type], item.message, item.status], ['', '', '', item.status === 'Active' ? 'alert-active' : 'alert-cleared']);
        $rows.append($tr);
      });
      $('#alerts-scroll').scrollTop(0);
  }

  function loadHistory() {
    const hours = Number($('#history-range').val() || 1);
    const bucketMinutes = hours === 1 ? 5 : hours === 6 ? 15 : 60;
    const bucketMs = bucketMinutes * 60 * 1000;
    const bucketCount = hours * 60 / bucketMinutes;
    $.getJSON('/api/readings/summary', { device_uid: deviceUid, hours }).done(function (items) {
      if (typeof Chart === 'undefined') return $('#history-message').text('Chart could not be loaded.');
      const bucketByTime = new Map(items.map(item => [
        Math.floor(new Date(item.bucket_at).getTime() / bucketMs) * bucketMs,
        item,
      ]));
      const rangeEnd = Math.floor(Date.now() / bucketMs) * bucketMs;
      const rangeStart = rangeEnd - bucketCount * bucketMs;
      const buckets = Array.from({ length: bucketCount }, function (_, index) {
        const timestamp = rangeStart + index * bucketMs;
        return { timestamp, reading: bucketByTime.get(timestamp) };
      });
      const labelsForChart = buckets.map(function (bucket) {
        const date = new Date(bucket.timestamp);
        return hours === 24
          ? date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit' })
          : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      });
      const sampleCount = items.reduce((total, item) => total + item.sample_count, 0);
      $('#history-message').text(sampleCount
        ? `Bars show ${bucketMinutes}-minute averages from ${sampleCount} readings.`
        : 'No readings in this time range.');
      const data = {
        labels: labelsForChart,
        datasets: [
          { label: 'Temperature (°C)', data: buckets.map(bucket => bucket.reading?.temperature ?? null), borderColor: '#f04a53', backgroundColor: 'rgba(240, 74, 83, 0.75)', yAxisID: 'temperature', borderWidth: 1, borderRadius: 2, categoryPercentage: .8, barPercentage: .85 },
          { label: 'Humidity (%)', data: buckets.map(bucket => bucket.reading?.humidity ?? null), borderColor: '#087cf0', backgroundColor: 'rgba(8, 124, 240, 0.7)', yAxisID: 'humidity', borderWidth: 1, borderRadius: 2, categoryPercentage: .8, barPercentage: .85 },
        ],
      };
      if (chart) {
        chart.data = data;
        chart.update();
      } else {
        chart = new Chart(document.getElementById('history-chart'), {
          type: 'bar', data,
          options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'top' } },
            scales: {
              temperature: { type: 'linear', position: 'left', title: { display: true, text: 'Temperature (°C)' } },
              humidity: { type: 'linear', position: 'right', min: 0, max: 100, title: { display: true, text: 'Humidity (%)' }, grid: { drawOnChartArea: false } },
            } },
        });
      }
    }).fail(function (xhr) {
      if (xhr.status === 401) return window.location.assign('/login');
      $('#history-message').text('History data unavailable.');
    });
  }

  function refresh() {
    loadCurrent();
    loadAccess();
    loadSnapshot();
    loadAlerts();
    loadHistory();
  }

  $('#access-filter').on('change', renderAccess);
  $('#alert-filter').on('change', renderAlerts);
  $('#nav-access').on('click', function () {
    document.getElementById('access-panel').scrollIntoView({ behavior: 'smooth' });
  });
  $('#history-range').on('change', loadHistory);
  startClock();
  refresh();
  window.setInterval(refresh, 5000);
});
