# Migration from the manual installation

1. Create a Home Assistant backup.
2. Do not delete `/config/.storage/matrix_notification_center`.
3. Remove the old top-level `matrix_notification_center:` block from
   `configuration.yaml`.
4. Under `panel_custom:`, remove only the Matrix Notification Center item.
5. Install the repository through HACS.
6. Restart Home Assistant.
7. Add Matrix Notification Center from **Settings → Devices & services**.
8. Open the automatically registered sidebar panel.

The config-flow version uses the same storage key and loads existing rules,
history, recipients and quiet-hour settings.


## New in 1.4.1

Existing entity conditions keep resolution confirmation disabled. Enable it individually in the advanced settings of a condition.


## New in 1.4.2

Existing conditions use `same`, which inherits the main notification level.
A different resolution severity can be selected in each entity condition's
advanced settings. No existing rule needs manual migration.
