.PHONY: dev server-dev web-dev simlab test test-server test-ts lint vectors-test seed reset

## dev: run API server and web client dev servers together
dev:
	$(MAKE) -j2 server-dev web-dev

server-dev:
	cd server && go run ./cmd/runad

web-dev:
	npm run dev -w web

## simlab: run the simulator dev server
simlab:
	npm run dev -w simlab

## seed: populate a RUNNING dev server with the test cast in
## web/scripts/seed-fixture.json (acts as real clients; word lists land in
## testKeys/seed-personas.json). Fresh-DB only — 409s if already seeded.
SEED_API_BASE ?= http://127.0.0.1:8080
seed:
	VITE_API_BASE=$(SEED_API_BASE) npm run seed -w web

## reset: delete the dev server's SQLite state. Stop the server first (a
## running server keeps writing to the deleted inode), restart it after,
## then `make seed` to repopulate.
reset:
	rm -f server/runa.db server/runa.db-wal server/runa.db-shm
	@echo "server DB removed — restart the server, then run 'make seed'"

test: test-server test-ts

test-server:
	cd server && go test ./...

test-ts:
	npm run test --workspaces --if-present

lint:
	cd server && go vet ./...
	npm run typecheck --workspaces --if-present

## vectors-test: cross-implementation protocol vectors (subset of test; kept as
## a named target so CI can gate on it explicitly)
vectors-test:
	cd server && go test ./... -run Vector
	npm run test -w packages/core -- --run vectors
