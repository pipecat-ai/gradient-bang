# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-04-19

### Added

- Event pruning cron job to prune stale non-important events (72h retention)
- Name validator with profanity and charset checks
- Disposable email domain blocking on signup
- Maintenance mode killswitch for login edge function
- Version plumbing: bot logs version on startup, sends version to client via RTVI on join
- `/release` skill for semver version bumps with CHANGELOG management
