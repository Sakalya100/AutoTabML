# Benchmark: `heuristic`

Scores are raw metric values on the locked test split (scored once per run). Optimism gap = select − test in oriented units (positive = the loop's own estimate was optimistic).

| dataset | metric | system | experiments (kept) | stop | dev CV | select | **test** | gap | cost $ | time s |
|---|---|---|---|---|---|---|---|---|---|---|
| iris_na | log_loss | starter | 1 (1) | max_experiments | 0.4914 | 0.09968 | **0.1665** | +0.06684 | 0.000 | 2.3 |
| iris_na | log_loss | evolve_stat | 40 (3) | max_experiments | 0.2016 | 0.0846 | **0.1067** | +0.02215 | 0.000 | 80.9 |
| iris_na | log_loss | evolve_naive | 40 (5) | max_experiments | 0.1638 | 0.0937 | **0.07416** | -0.01954 | 0.000 | 97.1 |
| iris_na | log_loss | evolve_ceiling | 21 (3) | ceiling | 0.2016 | 0.0846 | **0.1067** | +0.02215 | 0.000 | 48.9 |
| housing | rmse | starter | 1 (1) | max_experiments | 1.196e+06 | 1.238e+06 | **1.09e+06** | -1.476e+05 | 0.000 | 3.4 |
| housing | rmse | evolve_stat | 40 (3) | max_experiments | 1.156e+06 | 1.192e+06 | **9.955e+05** | -1.961e+05 | 0.000 | 92.4 |
| housing | rmse | evolve_naive | 40 (8) | max_experiments | 1.091e+06 | 1.106e+06 | **9.186e+05** | -1.871e+05 | 0.000 | 76.9 |
| housing | rmse | evolve_ceiling | 19 (2) | ceiling | 1.146e+06 | 1.199e+06 | **1e+06** | -1.983e+05 | 0.000 | 55.4 |
| breast_cancer | roc_auc | starter | 1 (1) | max_experiments | 0.9922 | 0.9884 | **0.9826** | +0.005787 | 0.000 | 3.0 |
| breast_cancer | roc_auc | evolve_stat | 40 (2) | max_experiments | 0.998 | 0.9861 | **0.9936** | -0.007523 | 0.000 | 67.4 |
| breast_cancer | roc_auc | evolve_naive | 40 (9) | max_experiments | 0.9981 | 0.9855 | **0.9931** | -0.007523 | 0.000 | 92.5 |
| breast_cancer | roc_auc | evolve_ceiling | 37 (4) | ceiling | 0.9979 | 0.9861 | **0.9936** | -0.007523 | 0.000 | 66.6 |
| wine | log_loss | starter | 1 (1) | max_experiments | 0.1018 | 0.112 | **0.05137** | -0.06063 | 0.000 | 2.2 |
| wine | log_loss | evolve_stat | 40 (3) | max_experiments | 0.09541 | 0.03005 | **0.01864** | -0.0114 | 0.000 | 64.6 |
| wine | log_loss | evolve_naive | 40 (7) | max_experiments | 0.08031 | 0.1354 | **0.05857** | -0.07679 | 0.000 | 65.6 |
| wine | log_loss | evolve_ceiling | 15 (2) | ceiling | 0.108 | 0.02919 | **0.02303** | -0.006156 | 0.000 | 29.7 |
| diabetes | rmse | starter | 1 (1) | max_experiments | 61.79 | 50.93 | **70.74** | +19.81 | 0.000 | 2.2 |
| diabetes | rmse | evolve_stat | 40 (5) | max_experiments | 57.96 | 47.52 | **66.03** | +18.51 | 0.000 | 82.1 |
| diabetes | rmse | evolve_naive | 40 (16) | max_experiments | 54.72 | 52.37 | **60.39** | +8.022 | 0.000 | 92.6 |
| diabetes | rmse | evolve_ceiling | 12 (3) | ceiling | 58.11 | 47.4 | **65.34** | +17.94 | 0.000 | 40.3 |
