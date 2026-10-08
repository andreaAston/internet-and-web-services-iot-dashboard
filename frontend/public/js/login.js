$(function () {
  const $form = $('#login-form');
  const $message = $('#login-message');
  const $submit = $form.find('button[type="submit"]');

  $('.password-toggle').on('click', function () {
    const $password = $('#password');
    const visible = $password.attr('type') === 'password';
    $password.attr('type', visible ? 'text' : 'password');
    $(this).attr('aria-pressed', String(visible)).attr('aria-label', visible ? 'Hide password' : 'Show password')
      .text(visible ? 'Hide' : 'Show');
    $password.trigger('focus');
  });

  $form.on('submit', function (event) {
    event.preventDefault();
    $message.text('');
    const username = $('#username').val().trim();
    const password = $('#password').val();
    if (!username || !password) {
      $message.text('Enter your username and password.');
      return;
    }

    $submit.prop('disabled', true).text('Signing in…');
    $.ajax({
      url: '/api/login', method: 'POST', contentType: 'application/json', timeout: 5000,
      data: JSON.stringify({ username, password }),
    }).done(function () {
      window.location.assign('/rooms');
    }).fail(function (xhr) {
      const message = xhr.responseJSON?.message;
      $message.text(message === 'Invalid username or password'
        ? 'The username or password is incorrect.'
        : (message || 'Could not sign in. Check your connection and try again.'));
    }).always(function () {
      $submit.prop('disabled', false).text('Sign In');
    });
  });
});
