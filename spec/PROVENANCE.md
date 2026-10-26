# Topology and preservation provenance

Authoritative editable repository: the owner's BenchBoard-Benchmark checkout. Candidates are Git commits, not directories. A sibling BenchBoard-Validation folder is a generated participant-run base only.

Permanent local labels: candidate.1 = 35786f8, candidate.2 = 582f4ae, candidate.3 = 1358799d801e14279b902253a217be4d112556d4. 2eb38ab is pre-normalization construction history; its historical candidate.1 label collided with the later authoritative exact-byte checkpoint. It is retained, not rewritten or deleted.

The restoration copies candidate.3 deadline-smoke.json directly from its reviewed packet, SHA-256 1d6d50c7c70eb9b9239d3ef27e70d5dfb970ddf32a9ca8a4ca7b31a77eb23958. No manual reconstruction. Packet integrity checks its own recorded bytes, input inventory, candidate tuple and digest. Freshness additionally compares the current tuple. Historical integrity does not require current sources to match; stale freshness is expected after edits.

Local owner-only archive (not published): pre-candidate4-20261006T032059Z. 417 files including both packets, owner evidence and a verified Git bundle with candidate tags. Archive SHA-256 manifest e7b7dd0479f5d3cc1e6abb71cc660c2cbb026787b18bec42221d22eb7df96c37. Every copied byte verified. Disposable node_modules/dist/product clones and participant-run base are excluded. No remote/upload created.

Append-only artifacts/methodology-history records recover candidate.1-to-.2 from candidate.2's preserved packet and .2-to-.3 from exact preserved tuples. Transition time is unknown. The legacy methodology-change.json remains historical; future transitions use new exclusive files, never overwrite prior records.

Self-test uses a disposable manifest, makes no formal deadline evidence, and hashes all historical review packet files plus their current source paths before/after every run. Formal deadline evidence is a separate explicit write-once runner/deadline-evidence.mjs operation. Reviewed tuple replacement under the same version is rejected. Encoding corrections are exact tokens verified against reference or reversible UTF-8/cp1252 decoding; original corruption operation is unknown. Historical packets stay unchanged. Explicit UTF-8 and .editorconfig pin future text handling. Fixture equality is deep JSON equality, not byte or line-ending equality.

This preservation repair is a new commit, not candidate.3. Candidate.4 starts only after the preservation checks pass, with the repair commit in its ancestry. No fairness workload remediation is part of this preservation checkpoint. No DSH calibration/configuration/teams/remote/release/freeze is authorized.

Preservation checks passed before fairness edits. Repair commit e13cbcd is the parent of branch candidate.4. The original Claude candidate.2 CHANGES_REQUESTED report was never saved by the review session; the owner supplied a preserved transcript-derived scratchpad JSON. It is copied byte-for-byte to artifacts/fairness-review-candidate.2.json and the external evidence archive, SHA-256 8e9601fae1311899fe8a72acdec2e1babbc5fe4ea8bda89d23fc1fab50520296 (23,458 bytes). This is a historical verdict, not a candidate.4 fairness approval. The archive original manifest remains unchanged; supplemental report preservation has a separate proof record.
