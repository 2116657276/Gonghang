SHELL := /bin/sh

PNPM ?= pnpm
SERVER := @xingzhi/server
SCENARIO_KEY ?= local-$(shell date +%Y%m%d-%H%M%S)
SCENARIO_DATE ?= $(shell date +%F)

.DEFAULT_GOAL := help

.PHONY: help install up up-backend dev migrate seed seed-finance seed-catalog seed-scenario \
	typecheck test check build build-h5 build-weapp build-web

help: ## 显示常用命令
	@printf '%s\n' \
		'make up              启动完整开发环境（macOS）' \
		'make up-backend      只启动后端 Server（macOS）' \
		'make dev             启动管理端、Server 和 Worker' \
		'make install         安装依赖' \
		'make migrate         执行数据库增量迁移' \
		'make seed            初始化本地 Demo 账号' \
		'make seed-finance    初始化消费者资金样例' \
		'make seed-catalog    初始化消费者商品目录' \
		'make seed-scenario   创建隔离消费者场景' \
		'make typecheck       执行全仓类型检查' \
		'make test            执行后端定向测试' \
		'make check           执行类型检查和定向测试' \
		'make build           构建全仓' \
		'make build-h5        构建消费者 H5' \
		'make build-weapp     构建微信小程序' \
		'make build-web       构建管理端'

install: ## 安装项目依赖
	$(PNPM) install

up: ## 启动完整开发环境（macOS）
	./start-xingzhi.zsh --restart

up-backend: ## 只启动后端 Server（macOS）
	./start-xingzhi.zsh --restart --backend-only --no-browser

dev: ## 启动管理端、Server 和 Worker
	$(PNPM) dev

migrate: ## 执行数据库增量迁移
	$(PNPM) db:migrate

seed: ## 初始化本地 Demo 账号
	$(PNPM) db:seed

seed-finance: ## 初始化消费者资金样例
	$(PNPM) --filter $(SERVER) db:seed:consumer-finance

seed-catalog: ## 初始化消费者商品目录
	$(PNPM) --filter $(SERVER) db:seed:consumer-catalog

seed-scenario: ## 创建隔离消费者场景，可用 SCENARIO_KEY=... SCENARIO_DATE=...
	$(PNPM) --filter $(SERVER) db:seed:consumer-scenario $(SCENARIO_KEY) $(SCENARIO_DATE)

typecheck: ## 执行全仓类型检查
	$(PNPM) typecheck

test: ## 执行后端定向测试
	$(PNPM) test:targeted

check: typecheck test ## 执行类型检查和定向测试

build: ## 构建全仓
	$(PNPM) build

build-h5: ## 构建消费者 H5
	$(PNPM) build:miniapp:h5

build-weapp: ## 构建微信小程序
	$(PNPM) build:miniapp:weapp

build-web: ## 构建管理端
	$(PNPM) --filter @xingzhi/web build
