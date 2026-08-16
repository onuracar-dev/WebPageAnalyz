# PostgreSQL backup and restore verification

These scripts operate through the repository's `postgres` Compose service. They never expose the database port publicly and never print credentials.

Production backups are encrypted by default. Install `age`, set `BACKUP_AGE_RECIPIENT` to an operator-controlled recipient, and keep the matching private identity outside the VDS.

```sh
export BACKUP_AGE_RECIPIENT='age1...'
./infra/backup/backup-postgres.sh /srv/webpage-analyzer/backups
./infra/backup/restore-check-postgres.sh /srv/webpage-analyzer/backups/webpage-analyzer-YYYYMMDDTHHMMSSZ.dump.age
```

`restore-check-postgres.sh` validates the checksum and archive, restores only into a generated `wpa_restore_check_*` database, executes bounded sanity queries, and removes that disposable database on exit. Run it after the first backup, after material schema changes, and at least monthly. A successful backup command without a successful restore check is not accepted as recoverability proof.

Store encrypted copies off the VDS with retention and access controls set by the operator. Do not place database credentials, `age` identities, or unencrypted customer backups in the repository.
