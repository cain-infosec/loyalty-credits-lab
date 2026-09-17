# Loyalty Credits Lab

A small, self-contained lab: a Node backend behind nginx with two fixed SQLite
accounts, packaged as a single Docker image.

**Full write-up and explanation:** https://blog.cain.tech

> For authorized security research and training only.

---

## Deploy

```bash
# with docker compose
docker compose up --build
# → http://localhost:8080

# or plain docker
docker build -t loyalty-credits-lab .
docker run --rm -p 8080:80 loyalty-credits-lab
# → http://localhost:8080
```

Fixed accounts:

| Role     | Email                 | Password        | Initial credits |
|----------|-----------------------|-----------------|-----------------|
| Sender   | `sender@lab.local`    | `Sender#2026`   | 5               |
| Receiver | `receiver@lab.local`  | `Receiver#2026` | 5               |

Reset to the initial state any time:

```bash
curl -X POST http://localhost:8080/api/loyalty/v1/lab/reset
```

---

## Exploit (`exploit.py`)

Standard library only — no `pip install` required.

```bash
# Simple run (10 transfers of 5 credits, sender -> receiver)
python exploit.py

# Tune it
python exploit.py --mode simple --count 20 --credits 5

# Compounding run
python exploit.py --mode exponential --rounds 3 --fanout 10

# Point it at another host/port
python exploit.py --base http://localhost:8080
```

The script resets the lab, drives the flow through the API, and prints both
wallets' balances after each step.
