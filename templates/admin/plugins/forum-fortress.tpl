<div class="row forum-fortress-admin ForumFortressDashboard">
	<div class="col-lg-12">
		<div class="ForumFortressPanel">
			<div class="ForumFortressCard ForumFortressHero">
				<div class="ForumFortressHeroHeader">
					<div class="ForumFortressMark" aria-hidden="true"><i></i><i></i><i></i></div>
					<div class="ForumFortressHeroCopy">
							<h1 class="ForumFortressHeroTitle">{{tx("forum-fortress:title")}}</h1>
						<span>{{tx("forum-fortress:tagline")}}</span>
					</div>
					<span class="ForumFortressPill is-checking" data-ff-status>{{tx("forum-fortress:dashboard.not_checked")}}</span>
				</div>
				<div class="ForumFortressActionGrid">
					<button class="btn btn-primary ForumFortressButton ForumFortressButton--portal" type="button" data-ff-action="portal">
						<i class="fa fa-external-link-alt" aria-hidden="true"></i><span>{{tx("forum-fortress:actions.open_portal")}}</span>
					</button>
					<button class="btn btn-outline-secondary ForumFortressButton" type="button" data-ff-action="test">
						<i class="fa fa-plug" aria-hidden="true"></i><span>{{tx("forum-fortress:actions.connection_test")}}</span>
					</button>
					<button class="btn btn-outline-warning ForumFortressButton ForumFortressButton--attack" type="button" data-ff-action="attack-start">
						<i class="fa fa-bolt" aria-hidden="true"></i><span>{{tx("forum-fortress:actions.attack_start")}}</span>
					</button>
					<button class="btn btn-outline-warning ForumFortressButton ForumFortressButton--attack" type="button" data-ff-action="attack-end">
						<i class="fa fa-shield-alt" aria-hidden="true"></i><span>{{tx("forum-fortress:actions.attack_end")}}</span>
					</button>
					<button class="btn btn-outline-secondary ForumFortressButton" type="button" data-ff-action="sync">
						<i class="fa fa-sync-alt" aria-hidden="true"></i><span>{{tx("forum-fortress:actions.synchronize")}}</span>
					</button>
				</div>
			</div>

			<div class="ForumFortressNotice d-none" role="alert" data-ff-message>
				<i data-ff-message-icon aria-hidden="true"></i>
				<span data-ff-message-text></span>
					<button class="btn btn-link ForumFortressNoticeDismiss" type="button" data-ff-dismiss aria-label="{{tx("forum-fortress:actions.dismiss")}}">&times;</button>
			</div>

			<div class="ForumFortressCard ForumFortressStatus">
				<div class="ForumFortressSectionHeader">
					<div>
						<strong>{{tx("forum-fortress:dashboard.title")}}</strong>
						<span>{{tx("forum-fortress:dashboard.status_summary")}}</span>
					</div>
					<button class="btn btn-link ForumFortressButton ForumFortressRefresh" type="button" data-ff-action="refresh">
						<i class="fa fa-redo-alt" aria-hidden="true"></i><span>{{tx("forum-fortress:actions.refresh")}}</span>
					</button>
				</div>
				<div class="ForumFortressStatusGrid">
					<div class="ForumFortressMetric is-good"><span>{{tx("forum-fortress:dashboard.protection")}}</span><strong data-ff-field="protection">{{tx("forum-fortress:dashboard.not_available")}}</strong></div>
					<div class="ForumFortressMetric"><span>{{tx("forum-fortress:dashboard.plan")}}</span><strong data-ff-field="plan">{{tx("forum-fortress:dashboard.not_available")}}</strong></div>
					<div class="ForumFortressMetric"><span>{{tx("forum-fortress:dashboard.site_id")}}</span><strong data-ff-field="site_id">{{tx("forum-fortress:dashboard.not_available")}}</strong></div>
					<div class="ForumFortressMetric"><span>{{tx("forum-fortress:dashboard.preferred_endpoint")}}</span><strong data-ff-field="endpoint">{{tx("forum-fortress:dashboard.not_available")}}</strong></div>
					<div class="ForumFortressMetric"><span>{{tx("forum-fortress:dashboard.checks_this_month")}}</span><strong data-ff-field="checks">{{tx("forum-fortress:dashboard.not_available")}}</strong></div>
					<div class="ForumFortressMetric"><span>{{tx("forum-fortress:dashboard.decisions")}}</span><strong data-ff-field="decisions">{{tx("forum-fortress:dashboard.not_available")}}</strong></div>
				</div>
			</div>

			<form role="form" class="forum-fortress-settings ForumFortressCard ForumFortressSettings">
				<div class="ForumFortressSectionHeader">
					<div>
						<strong>{{tx("forum-fortress:settings.title")}}</strong>
						<span>{{tx("forum-fortress:settings.save_help")}}</span>
					</div>
				</div>
				<div class="card-body">
					<div class="form-check form-switch mb-3">
						<input class="form-check-input" type="checkbox" id="ff-enabled" name="enabled" data-key="enabled" />
						<label class="form-check-label" for="ff-enabled">{{tx("forum-fortress:settings.enabled")}}</label>
					</div>
					<div class="row g-3">
						<div class="col-md-6">
							<label class="form-label" for="ff-region">{{tx("forum-fortress:settings.region")}}</label>
							<select class="form-select" id="ff-region" name="api_region" data-key="api_region">
								<option value="global">{{tx("forum-fortress:settings.region_global")}}</option>
								<option value="uk">{{tx("forum-fortress:settings.region_uk")}}</option>
								<option value="eu">{{tx("forum-fortress:settings.region_eu")}}</option>
								<option value="us">{{tx("forum-fortress:settings.region_us")}}</option>
							</select>
							<div class="form-text">{{tx("forum-fortress:settings.region_help")}}</div>
						</div>
						<div class="col-md-6 d-flex align-items-center">
							<div class="form-check form-switch">
								<input class="form-check-input" type="checkbox" id="ff-fallback" name="allow_global_fallback" data-key="allow_global_fallback" />
								<label class="form-check-label" for="ff-fallback">{{tx("forum-fortress:settings.global_fallback")}}</label>
							</div>
						</div>
						<div class="col-md-6">
							<label class="form-label" for="ff-api-key">{{tx("forum-fortress:settings.api_key")}}</label>
							<input class="form-control" type="password" id="ff-api-key" name="api_key" data-key="api_key" autocomplete="new-password" />
							<div class="form-text">{{tx("forum-fortress:settings.api_key_help")}}</div>
						</div>
						<div class="col-md-6">
							<label class="form-label" for="ff-email">{{tx("forum-fortress:settings.registration_email")}}</label>
							<input class="form-control" type="email" id="ff-email" name="registration_email" data-key="registration_email" autocomplete="email" />
						</div>
						<div class="col-md-3">
							<label class="form-label" for="ff-timeout">{{tx("forum-fortress:settings.timeout")}}</label>
							<input class="form-control" type="number" min="1" max="30" id="ff-timeout" name="timeout" data-key="timeout" />
						</div>
						<div class="col-md-9 d-flex align-items-center">
							<div class="form-check form-switch">
								<input class="form-check-input" type="checkbox" id="ff-fail-open" name="fail_open" data-key="fail_open" />
								<label class="form-check-label" for="ff-fail-open">{{tx("forum-fortress:settings.fail_open")}}</label>
								<div class="form-text">{{tx("forum-fortress:settings.fail_open_help")}}</div>
							</div>
						</div>
						<div class="col-12">
							<div class="form-check form-switch">
								<input class="form-check-input" type="checkbox" id="ff-debug" name="debug_log" data-key="debug_log" />
								<label class="form-check-label" for="ff-debug">{{tx("forum-fortress:settings.debug_log")}}</label>
							</div>
						</div>
					</div>
				</div>
				<div class="ForumFortressCardFooter">
					<button id="save" class="btn btn-primary ForumFortressButton" type="button"><i class="fa fa-save" aria-hidden="true"></i><span>{{tx("global:save")}}</span></button>
				</div>
			</form>

			<details class="ForumFortressCard ForumFortressMaintenance">
				<summary>
					<span><strong>{{tx("forum-fortress:maintenance.title")}}</strong><small>{{tx("forum-fortress:dashboard.maintenance_help")}}</small></span>
					<i class="fa fa-chevron-down" aria-hidden="true"></i>
				</summary>
				<div class="ForumFortressMaintenanceBody">
					<p>{{tx("forum-fortress:maintenance.help")}}</p>
					<div class="ForumFortressMaintenanceActions">
						<button class="btn btn-outline-primary ForumFortressButton" type="button" data-ff-action="register"><i class="fa fa-user-plus" aria-hidden="true"></i><span>{{tx("forum-fortress:actions.register_site")}}</span></button>
					</div>
					<div class="ForumFortressDisconnectHelp">
						<p>{{tx("forum-fortress:maintenance.confirm")}}</p>
						<button class="btn btn-outline-danger ForumFortressButton" type="button" data-ff-action="deprovision"><i class="fa fa-unlink" aria-hidden="true"></i><span>{{tx("forum-fortress:actions.disconnect")}}</span></button>
					</div>
				</div>
			</details>
		</div>
	</div>
</div>
