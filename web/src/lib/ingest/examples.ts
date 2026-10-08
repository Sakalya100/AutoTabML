/** Public datasets offered as one-click examples on /new. Each link was checked to download a CSV. */
export interface ExampleDataset {
  name: string;
  url: string;
  /** What a run on it predicts, in plain words. */
  blurb: string;
}

export const EXAMPLES: readonly ExampleDataset[] = [
  { name: "Titanic", url: "https://github.com/datasciencedojo/datasets/blob/master/titanic.csv", blurb: "who survived" },
  { name: "Breast cancer", url: "https://raw.githubusercontent.com/selva86/datasets/master/BreastCancer.csv", blurb: "malignant or benign" },
  { name: "Customer churn", url: "https://huggingface.co/datasets/scikit-learn/churn-prediction/blob/main/dataset.csv", blurb: "who cancels" },
  { name: "Boston housing", url: "https://raw.githubusercontent.com/selva86/datasets/master/BostonHousing.csv", blurb: "house prices" },
];
