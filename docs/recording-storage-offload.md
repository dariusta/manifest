# Move recording storage to S3

Recording objects contain encrypted bytes. Copy them without decoding, changing keys, or setting gzip content encoding. Keep the existing application encryption settings and database recording keys.

1. Prepare a private S3 bucket and a credential limited to its recording prefix. Keep the existing retention policy; check that bucket lifecycle rules do not expire objects earlier.
2. Copy from the configured filesystem root. Preserve each relative path as the S3 key and verify each object's SHA-256 checksum. Exclude temporary files. Keep the source intact.
3. Configure S3 and set `REQUEST_RECORDING_FILESYSTEM_FALLBACK_PATH` to the current filesystem root. Keep that volume mounted during the transition. New writes go to S3; a missing S3 object can still be read from the old filesystem.
4. Complete a final copy after the old filesystem-writing process has stopped. Verify every database-referenced recording, then test both old and newly created recordings through the authenticated application.
5. Remove the fallback setting only after every recording is verified in S3. Reclaim local copies separately after recovery and application reads have been verified.

The fallback is read-only. It does not mask S3 authorization or availability errors. Retention deletes affect S3 and clear database references; reclaiming the old filesystem remains a separate operation.
