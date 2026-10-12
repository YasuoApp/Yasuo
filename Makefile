# Packaging entry points. Everything that is not about producing an installer
# is a script in package.json and only wrapped here so `make help` lists it.
#
#   make dmg          a .dmg for this machine's architecture
#   make help         everything else

SHELL := /bin/bash

BUILDER := $(CURDIR)/node_modules/.bin/electron-builder
RELEASE := release

# uname's names are not electron-builder's names.
HOST_ARCH := $(shell uname -m | sed -e 's/x86_64/x64/' -e 's/aarch64/arm64/')
ARCH ?= $(HOST_ARCH)

# Unsigned by default: a local build should not fail because there is no
# Developer ID in the keychain — electron-builder falls back to an ad-hoc
# signature, which is enough to run the app on the machine that built it.
# `make dmg SIGN=1` opts back in to the real identity.
SIGN ?= 0
ifeq ($(SIGN),1)
  export CSC_IDENTITY_AUTO_DISCOVERY = true
else
  export CSC_IDENTITY_AUTO_DISCOVERY = false
endif

.DEFAULT_GOAL := help
.PHONY: help install dev build icon dmg dmg-arm64 dmg-x64 dmg-universal dmg-all app open-release clean clean-release lint typecheck test

help: ## Show this help
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	bun install

dev: ## Run the app against Vite
	bun run dev

build: ## Bundle the main process and the renderer (no installer)
	bun run build

# Rendered from resources/logo.svg, so packaging regenerates it from the one
# source rather than packaging whatever PNG was last committed.
icon: ## Regenerate resources/icon.png from resources/logo.svg
	bun scripts/app-icon.mjs

dmg: build icon ## Build a .dmg for this machine (ARCH=arm64|x64, SIGN=1 to code sign)
	$(BUILDER) --mac dmg --$(ARCH)
	@$(MAKE) --no-print-directory list-dmg

dmg-arm64: ## Build an Apple Silicon .dmg
	@$(MAKE) --no-print-directory dmg ARCH=arm64

dmg-x64: ## Build an Intel .dmg (downloads the x64 Electron on first run)
	@$(MAKE) --no-print-directory dmg ARCH=x64

dmg-universal: build icon ## Build one .dmg carrying both architectures
	$(BUILDER) --mac dmg --universal
	@$(MAKE) --no-print-directory list-dmg

dmg-all: build icon ## Build a separate .dmg per architecture
	$(BUILDER) --mac dmg --arm64 --x64
	@$(MAKE) --no-print-directory list-dmg

app: build icon ## Build the unpacked .app only — faster than a .dmg for a smoke test
	$(BUILDER) --mac --dir --$(ARCH)

.PHONY: list-dmg
list-dmg:
	@ls -lh $(RELEASE)/*.dmg 2>/dev/null || echo "no .dmg in $(RELEASE)"

open-release: ## Reveal the built artifacts in Finder
	open $(RELEASE)

lint: ## Lint the app
	bun run lint

typecheck: ## Typecheck the app
	bun run typecheck

test: ## Run the tests
	bun run test

clean-release: ## Remove built installers
	rm -rf $(RELEASE)

clean: clean-release ## Remove installers and build output
	rm -rf dist-electron dist-renderer
