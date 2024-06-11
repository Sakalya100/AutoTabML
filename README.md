# AutoTabML - Automated Machine Learning Code Generator for Tabular Data

AutoTabML is an innovative application designed to automate the generation of machine learning code for tabular data. Utilizing CrewAI and the Groq Llama 70B model, AutoTabML simplifies the process of building and debugging machine learning models for both regression and classification problems. With this tool, you can generate working code, debug errors, and run your code without writing a single line of code manually.

## Features

- **Automated Code Generation**: Generate Python code for machine learning tasks based on your tabular dataset and problem description.
- **EDA and Feature Engineering**: Perform comprehensive Exploratory Data Analysis (EDA) and feature engineering.
- **Model Recommendation**: Get suggestions for the most suitable machine learning models for your problem.
- **Code Modification and Debugging**: Modify generated code based on user suggestions and debug errors effortlessly.
- **In-app Execution**: Run the generated code within the application and view the results without the need for external IDEs or additional installations.

## How It Works

AutoTabML leverages multiple agents, each specializing in different aspects of the machine learning pipeline. Here's a brief overview of the agents and their roles:

- **Data Reader Agent**: Reads and loads the uploaded dataset.
- **Problem Definition Agent**: Clarifies the machine learning problem based on user input.
- **EDA Agent**: Performs exploratory data analysis to understand data characteristics.
- **Feature Engineering Agent**: Executes feature engineering based on EDA results.
- **Model Recommendation Agent**: Suggests the most suitable machine learning models.
- **Starter Code Generator Agent**: Generates the initial Python code template for the project.
- **Code Modification Agent**: Adapts the generated code according to user feedback.
- **Code Debugger Agent**: Debugs the generated code to fix any issues.
- **Compiler Agent**: Extracts and compiles the Python code.

## Technology Used
[<img src="https://user-images.githubusercontent.com/25181517/183423507-c056a6f9-1ba8-4312-a350-19bcbc5a8697.png" width="50px;"/>](https://github.com/shalusingh-tech) [<img src="https://user-images.githubusercontent.com/7164864/217935870-c0bc60a3-6fc0-4047-b011-7b4c59488c91.png" width="60px;"/>](https://github.com/shalusingh-tech)  [<img src="https://github.com/joaomdmoura/crewAI/blob/main/docs/crewai_logo.png" width="60px;"/>](https://github.com/shalusingh-tech)  [<img src="https://github.com/groq/groq-api-cookbook/blob/main/images/groq-logo.png" width="50px;"/>](https://github.com/shalusingh-tech)  

## Demo

### Classification Demo
https://github.com/Sakalya100/AutoTabML/assets/70064084/e157cd32-eb3f-44f1-a6da-b71e8367e3e7

### Regression Demo
https://github.com/Sakalya100/AutoTabML/assets/70064084/6ffcc9c5-4a8e-4d8b-b9f6-0eae93b39c33


## Getting Started

### Prerequisites

- Required Python packages (listed in `requirements.txt`)

### Installation

1. Clone the repository:

   ```bash
   git clone https://github.com/Sakalya100/AutoTabML.git
   cd AutoTabML
   ```

2. Create and activate a virtual environment:

   ```bash
   python3 -m venv venv
   source venv/bin/activate
   ```

3. Install the required packages:

   ```bash
   pip install -r requirements.txt
   ```

4. Set up the environment variables by creating a `.env` file in the root directory and adding your Groq API key:

   ```
   GROQ_API_KEY=your_groq_api_key
   ```

### Usage

1. Run the Streamlit application:

   ```bash
   streamlit run app.py
   ```

2. Open your web browser and go to `http://localhost:8501`.

3. Describe your machine learning problem and upload a sample CSV of your dataset.

4. Click on "Process" to generate the initial code. You can then modify, debug, and run the code directly within the application.

### Example Workflow

1. **Describe Your Problem**: Enter a detailed description of the machine learning problem you want to solve.
2. **Upload Dataset**: Upload your dataset in CSV format.
3. **Generate Code**: Click the "Process" button to generate the initial Python code.
4. **Modify and Debug**: Use the provided text areas to suggest code modifications or paste error messages for debugging.
5. **Run the Code**: Execute the generated code and view the results, including any plots or outputs generated during execution.

### Contributors

[<img src="https://github.com/shalusingh-tech.png" width="60px;"/>](https://github.com/shalusingh-tech)  [<img src="https://github.com/Sakalya100.png" width="60px;"/>](https://github.com/Sakalya100)     

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
