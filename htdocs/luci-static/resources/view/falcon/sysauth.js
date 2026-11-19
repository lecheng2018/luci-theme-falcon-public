'use strict';
'require view';
'require ui';

/*
 * Falcon login — behavior-only view.
 *
 * The markup (centered card, form fields, error slot) is rendered by
 * themes/falcon/sysauth.ut; this view wires the interactions:
 *   - focus the password field
 *   - reveal the error slot after a failed attempt (fuser)
 *   - paint the "Logging in…" spinner, then submit the form natively so the
 *     dispatcher's login POST flow is untouched
 */

return view.extend({
	render: function() {
		var form = document.querySelector('form.fx-login-form');
		if (!form) return E('div');

		var box = document.querySelector('.login-box');
		var btn = form.querySelector('button[type="submit"]');
		var pw = form.querySelector('input[type="password"]');
		var err = box ? box.querySelector('[data-login-error]') : null;

		/* failed attempt — the template only renders the slot when fuser is set */
		if (err) err.style.display = '';

		if (pw) pw.focus();

		form.addEventListener('submit', function(ev) {
			ev.preventDefault();

			/* hide the card content and show a spinner before navigating */
			Array.prototype.forEach.call(
				form.querySelectorAll('.form-group, .login-head'),
				function(node) { node.style.display = 'none'; });
			if (btn) btn.style.display = 'none';

			var spin = E('div', { 'class': 'spinning' }, _('正在登录…'));
			form.appendChild(spin);

			/* let the browser paint the spinner before the POST navigates */
			window.setTimeout(function() { form.submit(); }, 30);
		});

		return E('div');
	},

	addFooter: function() {}
});